"""Requirement #2: monitor AI/crypto/Solana/OpenAI/Anthropic/Nvidia/Bitcoin/
Ethereum/tech news. Uses public RSS feeds (feedparser) — free, no API key,
no rate-limit surprises, unlike most news APIs. core/config.py's
NEWS_FEED_URLS env var can override/extend the default feed list."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

import feedparser

from core.config import settings

logger = logging.getLogger("news.fetcher")


@dataclass
class NewsItem:
    title: str
    summary: str
    url: str
    published_at: datetime
    source: str


def fetch_latest(since_minutes: int = 30) -> list[NewsItem]:
    cutoff = datetime.now(timezone.utc).timestamp() - since_minutes * 60
    items: list[NewsItem] = []

    for feed_url in settings.news_feeds:
        try:
            parsed = feedparser.parse(feed_url)
        except Exception as err:  # noqa: BLE001 — one dead feed must never kill the poll
            logger.warning("Failed to fetch feed %s: %s", feed_url, err)
            continue

        source = parsed.feed.get("title", feed_url)
        for entry in parsed.entries[:20]:
            published_struct = entry.get("published_parsed") or entry.get("updated_parsed")
            published_ts = (
                datetime(*published_struct[:6], tzinfo=timezone.utc).timestamp()
                if published_struct
                else datetime.now(timezone.utc).timestamp()
            )
            if published_ts < cutoff:
                continue

            summary = entry.get("summary", "") or entry.get("description", "")
            items.append(
                NewsItem(
                    title=entry.get("title", "").strip(),
                    summary=_strip_html(summary)[:500],
                    url=entry.get("link", ""),
                    published_at=datetime.fromtimestamp(published_ts, tz=timezone.utc),
                    source=source,
                )
            )

    items.sort(key=lambda i: i.published_at, reverse=True)
    return items


def _strip_html(raw: str) -> str:
    import re

    return re.sub(r"<[^>]+>", "", raw).strip()
