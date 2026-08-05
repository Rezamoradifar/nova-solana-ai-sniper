"""Requirement #15: scheduler that optimizes posting time using historical
engagement. Buckets past posts by hour-of-day, averages their engagement
score, and ranks hours — agent/main.py's scheduler consults this before
picking when to fire the next post."""

from __future__ import annotations

from collections import defaultdict

from analytics.metrics import engagement_score
from memory import db

# Until enough history exists, fall back to generically strong English-speaking
# X engagement windows (UTC) rather than posting uniformly at random.
DEFAULT_GOOD_HOURS_UTC = [13, 14, 15, 17, 19, 21, 23, 1]
MIN_SAMPLES_BEFORE_TRUSTING_DATA = 20


def best_posting_hours(top_n: int = 8) -> list[int]:
    engagement_by_tweet = {row["tweet_id"]: engagement_score(row) for row in db.latest_engagement_per_tweet()}
    posts = [p for p in db.all_posts() if p["tweet_id"] in engagement_by_tweet]

    if len(posts) < MIN_SAMPLES_BEFORE_TRUSTING_DATA:
        return DEFAULT_GOOD_HOURS_UTC[:top_n]

    totals: dict[int, float] = defaultdict(float)
    counts: dict[int, int] = defaultdict(int)
    for post in posts:
        hour = post["hour_of_day"]
        totals[hour] += engagement_by_tweet[post["tweet_id"]]
        counts[hour] += 1

    averages = {hour: totals[hour] / counts[hour] for hour in totals}
    ranked = sorted(averages.items(), key=lambda pair: pair[1], reverse=True)
    hours = [hour for hour, _ in ranked[:top_n]]
    return hours or DEFAULT_GOOD_HOURS_UTC[:top_n]
