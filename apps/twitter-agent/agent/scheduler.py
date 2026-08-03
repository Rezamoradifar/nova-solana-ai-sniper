"""Wires every scheduled behavior together with APScheduler:
- N (posts_per_day_min..max) original posts/day at data-driven optimal hours
  (requirement #1 + #15)
- continuous news monitoring feeding the news-rewrite content type (#2, #3)
- periodic trend detection + quote-tweeting (#6, #7)
- frequent mention polling + reply (#8)
- a daily analytics report + style-note update (#9, #19)
"""

from __future__ import annotations

import logging
import random
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from agent.pipeline import generate_with_gate, publish_post, score_and_gate
from analytics.reporter import generate_daily_report
from analytics.scheduler_optimizer import best_posting_hours
from core.config import settings
from core.models import ContentType, GeneratedPost
from llm import claude_client
from memory import db
from news.rewriter import fresh_news_items, rewrite_one
from twitter.client import twitter_client

logger = logging.getLogger("agent.scheduler")

TREND_KEYWORDS = ["AI", "Solana", "Bitcoin", "Ethereum", "Anthropic", "OpenAI", "Nvidia", "crypto"]
MAX_QUOTE_TWEETS_PER_DAY = 3


# -- content generation rotation --------------------------------------------


def _pick_generator():
    """Weighted rotation across content types. News rewrite only enters the
    pool when there's genuinely fresh, unused news — otherwise it's original
    thought / philosophical thread / controversial opinion."""
    fresh_news = fresh_news_items(since_minutes=180)
    style_notes = db.get_style_notes()

    choices: list[tuple[str, float]] = [
        ("original_thought", 0.40),
        ("controversial_opinion", 0.25),
        ("philosophical_thread", 0.20),
    ]
    if fresh_news:
        choices.append(("news_rewrite", 0.15))

    names = [c[0] for c in choices]
    weights = [c[1] for c in choices]
    choice = random.choices(names, weights=weights, k=1)[0]

    if choice == "news_rewrite" and fresh_news:
        item = fresh_news[0]
        return lambda: rewrite_one(item)
    if choice == "philosophical_thread":
        return lambda: claude_client.generate_philosophical_thread()
    if choice == "controversial_opinion":
        return lambda: claude_client.generate_controversial_opinion()
    return lambda: claude_client.generate_original_thought(style_notes)


def run_scheduled_post() -> None:
    try:
        post = generate_with_gate(_pick_generator())
        if post is None:
            logger.warning("No publishable post generated this slot — skipping.")
            return
        publish_post(post)
    except Exception:  # noqa: BLE001 — one bad slot must never kill the scheduler process
        logger.exception("run_scheduled_post failed")


# -- trend detection + quote-tweeting ----------------------------------------


def _quotes_posted_today() -> int:
    since = datetime.now(timezone.utc).date().isoformat()
    return sum(
        1
        for p in db.all_posts()
        if p["content_type"] == ContentType.QUOTE_TWEET.value and p["posted_at"].startswith(since)
    )


def run_trend_check() -> None:
    try:
        if _quotes_posted_today() >= MAX_QUOTE_TWEETS_PER_DAY:
            return
        trends = twitter_client.detect_trending_topics(TREND_KEYWORDS)
        for trend in trends:
            if not trend.sample_tweet_id or db.has_quoted(trend.sample_tweet_id):
                continue
            comment = claude_client.generate_quote_insight(trend.sample_text or "")
            if not comment or comment.strip().upper() == "SKIP":
                continue
            candidate = GeneratedPost(text=comment, content_type=ContentType.QUOTE_TWEET)
            score = score_and_gate(candidate)
            if score is None:
                continue
            tweet_id = twitter_client.quote_tweet(trend.sample_tweet_id, comment)
            if tweet_id:
                db.mark_quoted(trend.sample_tweet_id)
                db.save_post(
                    tweet_id=tweet_id,
                    content_type=ContentType.QUOTE_TWEET.value,
                    text=comment,
                    hashtags=[],
                    source_url=None,
                    score_total=score.total,
                    score_breakdown=score.__dict__,
                )
            break  # at most one quote-tweet per check cycle
    except Exception:  # noqa: BLE001
        logger.exception("run_trend_check failed")


# -- mentions ------------------------------------------------------------------


def run_mention_check() -> None:
    try:
        mentions = twitter_client.fetch_recent_mentions()
        for mention in mentions:
            if db.has_processed_mention(mention.tweet_id):
                continue
            history = db.get_conversation_history(mention.author_id)
            reply_text = claude_client.generate_mention_reply(
                mention.author_username, mention.text, history
            )
            db.mark_mention_processed(mention.tweet_id, mention.author_username)
            if not reply_text or reply_text.strip().upper() == "SKIP":
                continue
            tweet_id = twitter_client.reply(mention.tweet_id, reply_text)
            if tweet_id:
                db.append_conversation_turn(mention.author_id, "user", mention.text)
                db.append_conversation_turn(mention.author_id, "agent", reply_text)
    except Exception:  # noqa: BLE001
        logger.exception("run_mention_check failed")


# -- daily report ---------------------------------------------------------------


def run_daily_report() -> None:
    try:
        generate_daily_report()
    except Exception:  # noqa: BLE001
        logger.exception("run_daily_report failed")


# -- scheduling the day's post slots ----------------------------------------------


def _schedule_todays_posts(scheduler: BackgroundScheduler) -> None:
    for job in scheduler.get_jobs():
        if job.id.startswith("post_slot_"):
            job.remove()

    post_count = random.randint(settings.posts_per_day_min, settings.posts_per_day_max)
    hours = best_posting_hours(top_n=max(post_count, 8))
    chosen_hours = random.sample(hours, k=min(post_count, len(hours)))

    now = datetime.now(timezone.utc)
    for i, hour in enumerate(chosen_hours):
        run_time = now.replace(hour=hour, minute=random.randint(0, 59), second=0, microsecond=0)
        if run_time <= now:
            run_time += timedelta(days=1)
        scheduler.add_job(
            run_scheduled_post,
            "date",
            run_date=run_time,
            id=f"post_slot_{i}",
            misfire_grace_time=3600,
        )
    logger.info("Scheduled %s posts for the next 24h at hours (UTC): %s", len(chosen_hours), sorted(chosen_hours))


def start(scheduler: BackgroundScheduler) -> None:
    _schedule_todays_posts(scheduler)
    scheduler.add_job(_schedule_todays_posts, IntervalTrigger(hours=24), args=[scheduler], id="reschedule_posts")
    scheduler.add_job(
        run_trend_check, IntervalTrigger(seconds=settings.trend_poll_interval_seconds), id="trend_check"
    )
    scheduler.add_job(
        run_mention_check, IntervalTrigger(seconds=settings.mention_poll_interval_seconds), id="mention_check"
    )
    scheduler.add_job(run_daily_report, IntervalTrigger(hours=24), id="daily_report")
