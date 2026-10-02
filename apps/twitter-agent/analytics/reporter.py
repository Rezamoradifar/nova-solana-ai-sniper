"""Requirement #19: automatic analytics report every 24 hours. Requirement
#9's other half: feeds the top-performing posts back into Claude to update
the persisted style notes that future generations read."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

from analytics.metrics import engagement_score, refresh_engagement_snapshots, top_performing_texts
from analytics.scheduler_optimizer import best_posting_hours
from llm.claude_client import summarize_style_from_top_posts
from memory import db
from twitter.client import twitter_client

logger = logging.getLogger("analytics.reporter")


def generate_daily_report() -> dict:
    refresh_engagement_snapshots()

    since = datetime.now(timezone.utc) - timedelta(hours=24)
    posts_24h = [p for p in db.all_posts() if datetime.fromisoformat(p["posted_at"]) >= since]

    engagement_by_tweet = {row["tweet_id"]: engagement_score(row) for row in db.latest_engagement_per_tweet()}
    total_engagement = sum(engagement_by_tweet.get(p["tweet_id"], 0) for p in posts_24h)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "posts_last_24h": len(posts_24h),
        "total_engagement_score_24h": total_engagement,
        "followers": twitter_client.follower_count(),
        "best_posting_hours_utc": best_posting_hours(),
        "top_posts": top_performing_texts(limit=5),
    }

    logger.info("Daily report: %s", json.dumps(report, default=str))

    # Requirement #9: adjust writing style based on what performed best.
    top_texts = top_performing_texts(limit=15)
    if top_texts:
        notes = summarize_style_from_top_posts(top_texts)
        if notes:
            db.set_style_notes(notes)
            logger.info("Updated style notes: %s", notes)

    return report
