"""Pulls live engagement numbers for every tracked tweet and stores a
snapshot — the raw data every other analytics module (scheduler_optimizer,
reporter, dashboard) reads back out of memory/db.py."""

from __future__ import annotations

import logging

from memory import db
from twitter.client import twitter_client

logger = logging.getLogger("analytics.metrics")


def refresh_engagement_snapshots(limit: int = 200) -> int:
    tweet_ids = db.tracked_tweet_ids(limit=limit)
    if not tweet_ids:
        return 0
    snapshots = twitter_client.get_engagement(tweet_ids)
    for snap in snapshots:
        db.save_engagement_snapshot(
            snap.tweet_id, snap.likes, snap.retweets, snap.replies, snap.quotes, snap.impressions
        )
    logger.info("Refreshed engagement for %s tweets", len(snapshots))
    return len(snapshots)


def engagement_score(row) -> float:
    """Simple weighted engagement score used to rank posts — retweets/quotes
    (active amplification) weigh more than passive likes."""
    return row["likes"] * 1.0 + row["retweets"] * 3.0 + row["quotes"] * 3.0 + row["replies"] * 2.0


def top_performing_texts(limit: int = 15) -> list[str]:
    engagement_by_tweet = {row["tweet_id"]: engagement_score(row) for row in db.latest_engagement_per_tweet()}
    posts = [p for p in db.all_posts() if p["tweet_id"] in engagement_by_tweet]
    posts.sort(key=lambda p: engagement_by_tweet.get(p["tweet_id"], 0), reverse=True)
    return [p["text"] for p in posts[:limit]]
