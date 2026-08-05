"""Shared dataclasses passed between modules. Keeping these in one place
means llm/, twitter/, memory/, and analytics/ all agree on shape without
importing each other directly."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class ContentType(str, Enum):
    ORIGINAL_THOUGHT = "original_thought"
    NEWS_REWRITE = "news_rewrite"
    PHILOSOPHICAL_THREAD = "philosophical_thread"
    CONTROVERSIAL_OPINION = "controversial_opinion"
    QUOTE_TWEET = "quote_tweet"
    MENTION_REPLY = "mention_reply"
    # Real, verifiable data about the bot itself — see news/bot_trades.py.
    TRADE_HIGHLIGHT = "trade_highlight"
    FEATURE_HIGHLIGHT = "feature_highlight"


@dataclass
class ScoreBreakdown:
    virality: float
    curiosity: float
    emotion: float
    humor: float
    novelty: float
    readability: float
    rationale: str = ""

    @property
    def total(self) -> float:
        # Equal-weighted average across all six axes, each already 0-100.
        return (
            self.virality
            + self.curiosity
            + self.emotion
            + self.humor
            + self.novelty
            + self.readability
        ) / 6.0


@dataclass
class GeneratedPost:
    text: str
    content_type: ContentType
    thread_parts: list[str] = field(default_factory=list)
    hashtags: list[str] = field(default_factory=list)
    source_url: str | None = None
    source_title: str | None = None
    image_prompt: str | None = None
    score: ScoreBreakdown | None = None


@dataclass
class TrendTopic:
    keyword: str
    tweet_count: int
    sample_tweet_id: str | None = None
    sample_text: str | None = None


@dataclass
class MentionEvent:
    tweet_id: str
    author_id: str
    author_username: str
    text: str
    conversation_id: str
    created_at: datetime


@dataclass
class EngagementSnapshot:
    tweet_id: str
    likes: int
    retweets: int
    replies: int
    quotes: int
    impressions: int
    captured_at: datetime
