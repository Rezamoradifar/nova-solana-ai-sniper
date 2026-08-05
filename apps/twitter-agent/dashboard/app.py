"""Requirement #14: a small read-only dashboard — followers, engagement,
CTR (approximated as engagement rate; see note below), best posting hours,
trending topics, and an AI-generated recommendation. Runs as a second
process alongside the scheduler (see docker/start.sh), reading the same
SQLite file."""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from analytics.metrics import top_performing_texts
from analytics.scheduler_optimizer import best_posting_hours
from core.config import settings
from llm.claude_client import generate_recommendations
from memory import db
from twitter.client import twitter_client

logger = logging.getLogger("dashboard")

app = FastAPI(title=f"{settings.agent_name} Dashboard")
templates = Jinja2Templates(directory="dashboard/templates")


def _build_snapshot() -> dict:
    db.init_db()
    engagement_rows = db.latest_engagement_per_tweet()
    total_impressions = sum(r["impressions"] for r in engagement_rows)
    total_engagement_actions = sum(
        r["likes"] + r["retweets"] + r["replies"] + r["quotes"] for r in engagement_rows
    )
    # NOTE on "CTR": X's public API v2 (even paid tiers) does not expose link
    # click-through counts — that requires X Ads/Analytics access. This is an
    # engagement-rate proxy (actions / impressions), clearly labeled as such
    # rather than presenting a number that looks like real link CTR.
    engagement_rate = (total_engagement_actions / total_impressions * 100) if total_impressions else 0.0

    trending_keywords = ["AI", "Solana", "Bitcoin", "Ethereum", "Anthropic", "OpenAI", "Nvidia"]
    trends = twitter_client.detect_trending_topics(trending_keywords)

    report_summary = {
        "followers": twitter_client.follower_count(),
        "engagement_rate_percent": round(engagement_rate, 2),
        "total_posts": len(db.all_posts()),
        "best_posting_hours_utc": best_posting_hours(),
        "trending_topics": [t.keyword for t in trends],
    }
    recommendations = generate_recommendations(report_summary)

    return {
        "agent_name": settings.agent_name,
        "followers": report_summary["followers"],
        "engagement_rate_percent": report_summary["engagement_rate_percent"],
        "total_posts": report_summary["total_posts"],
        "best_hours": report_summary["best_posting_hours_utc"],
        "trends": trends,
        "top_posts": top_performing_texts(limit=5),
        "recommendations": recommendations,
    }


@app.get("/", response_class=HTMLResponse)
def dashboard_home(request: Request):
    data = _build_snapshot()
    return templates.TemplateResponse(request, "dashboard.html", data)


@app.get("/api/snapshot")
def api_snapshot():
    return _build_snapshot()


@app.get("/healthz")
def healthz():
    return {"status": "ok"}
