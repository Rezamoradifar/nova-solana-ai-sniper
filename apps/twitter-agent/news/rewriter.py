"""Bridges news/fetcher.py and llm/claude_client.py: picks fresh
(not-yet-used) news items and turns them into GeneratedPost objects."""

from __future__ import annotations

import hashlib
import logging

from core.models import GeneratedPost
from llm import claude_client
from memory import db
from news.fetcher import NewsItem, fetch_latest

logger = logging.getLogger("news.rewriter")


def _fingerprint(url: str) -> str:
    return "url:" + hashlib.sha256(url.encode("utf-8")).hexdigest()


def fresh_news_items(since_minutes: int = 30) -> list[NewsItem]:
    items = fetch_latest(since_minutes=since_minutes)
    return [item for item in items if item.url and not db.idea_already_used(_fingerprint(item.url))]


def rewrite_one(item: NewsItem) -> GeneratedPost | None:
    try:
        post = claude_client.rewrite_news(item.title, item.summary, item.url)
    except Exception as err:  # noqa: BLE001 — a single bad rewrite must never crash the loop
        logger.error("Failed to rewrite news item %s: %s", item.url, err)
        return None
    if not post.text:
        return None
    db.mark_idea_used(_fingerprint(item.url))
    return post
