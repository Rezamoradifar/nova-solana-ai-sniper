"""Central environment/config loader. Every other module reads settings from
here instead of touching os.environ directly, so required vars fail loud at
startup rather than surfacing as a KeyError deep inside a scheduled job."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _optional(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw else default


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw else default


@dataclass(frozen=True)
class Settings:
    # Twitter / X API v2
    twitter_api_key: str
    twitter_api_secret: str
    twitter_access_token: str
    twitter_access_secret: str
    twitter_bearer_token: str

    # LLM providers
    anthropic_api_key: str
    openai_api_key: str
    claude_model: str

    # Identity
    agent_name: str
    solana_wallet_address: str

    # Behavior tuning
    posts_per_day_min: int
    posts_per_day_max: int
    min_publish_score: float
    max_generation_attempts: int
    mention_poll_interval_seconds: int
    trend_poll_interval_seconds: int
    news_poll_interval_seconds: int
    max_hashtags: int

    # Storage
    db_path: str
    redis_url: str

    # Dashboard
    dashboard_host: str
    dashboard_port: int

    news_feeds: list[str] = field(default_factory=list)


def load_settings() -> Settings:
    default_feeds = [
        "https://www.coindesk.com/arc/outboundfeeds/rss/",
        "https://cointelegraph.com/rss",
        "https://www.theblock.co/rss.xml",
        "https://feeds.arstechnica.com/arstechnica/technology-lab",
        "https://www.technologyreview.com/feed/",
        "https://openai.com/news/rss.xml",
        "https://www.anthropic.com/rss.xml",
        "https://blogs.nvidia.com/feed/",
        "https://solana.com/news/rss.xml",
    ]
    raw_feeds = _optional("NEWS_FEED_URLS")
    news_feeds = [u.strip() for u in raw_feeds.split(",") if u.strip()] if raw_feeds else default_feeds

    return Settings(
        twitter_api_key=_require("TWITTER_API_KEY"),
        twitter_api_secret=_require("TWITTER_API_SECRET"),
        twitter_access_token=_require("TWITTER_ACCESS_TOKEN"),
        twitter_access_secret=_require("TWITTER_ACCESS_SECRET"),
        twitter_bearer_token=_require("TWITTER_BEARER_TOKEN"),
        anthropic_api_key=_require("ANTHROPIC_API_KEY"),
        openai_api_key=_require("OPENAI_API_KEY"),
        claude_model=_optional("CLAUDE_MODEL", "claude-sonnet-4-5"),
        agent_name=_optional("AGENT_NAME", "Terminal_X"),
        solana_wallet_address=_optional("SOLANA_WALLET_ADDRESS"),
        posts_per_day_min=_int("POSTS_PER_DAY_MIN", 8),
        posts_per_day_max=_int("POSTS_PER_DAY_MAX", 12),
        min_publish_score=_float("MIN_PUBLISH_SCORE", 92.0),
        max_generation_attempts=_int("MAX_GENERATION_ATTEMPTS", 4),
        mention_poll_interval_seconds=_int("MENTION_POLL_INTERVAL_SECONDS", 90),
        trend_poll_interval_seconds=_int("TREND_POLL_INTERVAL_SECONDS", 1800),
        news_poll_interval_seconds=_int("NEWS_POLL_INTERVAL_SECONDS", 900),
        max_hashtags=_int("MAX_HASHTAGS", 2),
        db_path=_optional("DB_PATH", "memory.sqlite3"),
        redis_url=_optional("REDIS_URL"),
        dashboard_host=_optional("DASHBOARD_HOST", "0.0.0.0"),
        dashboard_port=_int("DASHBOARD_PORT", 8080),
        news_feeds=news_feeds,
    )


settings = load_settings()
