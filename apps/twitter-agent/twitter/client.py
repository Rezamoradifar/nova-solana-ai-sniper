"""Tweepy (Twitter API v2) wrapper. Every network call goes through
`_with_retry`, which retries on rate limits (429) and transient
disconnects with exponential backoff — nothing upstream needs its own
try/except for that class of failure."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import TypeVar

import tweepy

from core.config import settings
from core.models import EngagementSnapshot, MentionEvent, TrendTopic

logger = logging.getLogger("twitter.client")

T = TypeVar("T")

MAX_RETRIES = 5
BASE_BACKOFF_SECONDS = 5


class TwitterClient:
    def __init__(self) -> None:
        self.client = tweepy.Client(
            bearer_token=settings.twitter_bearer_token,
            consumer_key=settings.twitter_api_key,
            consumer_secret=settings.twitter_api_secret,
            access_token=settings.twitter_access_token,
            access_token_secret=settings.twitter_access_secret,
            wait_on_rate_limit=False,  # we handle backoff ourselves, see _with_retry
        )
        self._me_id: str | None = None

    # -- resilience -----------------------------------------------------

    def _with_retry(self, fn: Callable[[], T], label: str) -> T | None:
        last_err: Exception | None = None
        for attempt in range(MAX_RETRIES):
            try:
                return fn()
            except tweepy.TooManyRequests as err:
                last_err = err
                reset = err.response.headers.get("x-rate-limit-reset") if err.response else None
                wait = max(1, int(reset) - int(time.time())) if reset else BASE_BACKOFF_SECONDS * (2**attempt)
                logger.warning("%s: rate-limited, waiting %ss (attempt %s)", label, wait, attempt + 1)
                time.sleep(min(wait, 900))
            except (tweepy.TwitterServerError, tweepy.errors.HTTPException) as err:
                last_err = err
                backoff = BASE_BACKOFF_SECONDS * (2**attempt)
                logger.warning("%s: transient error %s, retrying in %ss", label, err, backoff)
                time.sleep(backoff)
            except tweepy.Forbidden as err:
                # Never worth retrying (duplicate content, blocked action, suspended target, ...).
                logger.error("%s: forbidden, not retrying: %s", label, err)
                return None
        logger.error("%s: giving up after %s attempts: %s", label, MAX_RETRIES, last_err)
        return None

    # -- identity ---------------------------------------------------------

    def my_user_id(self) -> str:
        if self._me_id is None:
            me = self._with_retry(lambda: self.client.get_me(), "get_me")
            self._me_id = str(me.data.id) if me and me.data else ""
        return self._me_id

    # -- posting ------------------------------------------------------------

    def post_tweet(self, text: str, image_bytes: bytes | None = None) -> str | None:
        media_ids = None
        if image_bytes:
            media_id = self._upload_media(image_bytes)
            media_ids = [media_id] if media_id else None

        def _do():
            return self.client.create_tweet(text=text, media_ids=media_ids)

        response = self._with_retry(_do, "post_tweet")
        return str(response.data["id"]) if response and response.data else None

    def post_thread(self, parts: list[str]) -> list[str]:
        """Requirement #18: each part replies to the previous one, forming
        a real thread rather than N unrelated tweets."""
        posted_ids: list[str] = []
        reply_to: str | None = None
        for part in parts:
            def _do(text=part, reply_id=reply_to):
                return self.client.create_tweet(
                    text=text,
                    in_reply_to_tweet_id=reply_id,
                )

            response = self._with_retry(_do, "post_thread_part")
            if not response or not response.data:
                break
            tweet_id = str(response.data["id"])
            posted_ids.append(tweet_id)
            reply_to = tweet_id
        return posted_ids

    def reply(self, tweet_id: str, text: str) -> str | None:
        def _do():
            return self.client.create_tweet(text=text, in_reply_to_tweet_id=tweet_id)

        response = self._with_retry(_do, "reply")
        return str(response.data["id"]) if response and response.data else None

    def quote_tweet(self, tweet_id: str, text: str) -> str | None:
        def _do():
            return self.client.create_tweet(text=text, quote_tweet_id=tweet_id)

        response = self._with_retry(_do, "quote_tweet")
        return str(response.data["id"]) if response and response.data else None

    def _upload_media(self, image_bytes: bytes) -> str | None:
        # media upload (v1.1 endpoint — v2 has no direct media upload yet)
        try:
            auth = tweepy.OAuth1UserHandler(
                settings.twitter_api_key,
                settings.twitter_api_secret,
                settings.twitter_access_token,
                settings.twitter_access_secret,
            )
            api_v1 = tweepy.API(auth)
            import io

            media = api_v1.media_upload(filename="image.png", file=io.BytesIO(image_bytes))
            return str(media.media_id)
        except Exception as err:  # noqa: BLE001 — image is optional, never blocks the tweet
            logger.warning("Media upload failed, posting without image: %s", err)
            return None

    # -- mentions -----------------------------------------------------------

    def fetch_recent_mentions(self, since_id: str | None = None) -> list[MentionEvent]:
        user_id = self.my_user_id()
        if not user_id:
            return []

        def _do():
            return self.client.get_users_mentions(
                id=user_id,
                since_id=since_id,
                max_results=50,
                tweet_fields=["created_at", "conversation_id", "author_id"],
                expansions=["author_id"],
            )

        response = self._with_retry(_do, "fetch_mentions")
        if not response or not response.data:
            return []

        users_by_id = {str(u.id): u.username for u in (response.includes or {}).get("users", [])}
        events = []
        for tweet in response.data:
            events.append(
                MentionEvent(
                    tweet_id=str(tweet.id),
                    author_id=str(tweet.author_id),
                    author_username=users_by_id.get(str(tweet.author_id), "unknown"),
                    text=tweet.text,
                    conversation_id=str(tweet.conversation_id),
                    created_at=tweet.created_at or datetime.now(timezone.utc),
                )
            )
        return events

    # -- trends / search ------------------------------------------------------

    def search_recent(self, query: str, max_results: int = 20) -> list[dict]:
        def _do():
            return self.client.search_recent_tweets(
                query=query,
                max_results=max_results,
                tweet_fields=["public_metrics", "created_at"],
            )

        response = self._with_retry(_do, "search_recent")
        if not response or not response.data:
            return []
        return [
            {
                "id": str(t.id),
                "text": t.text,
                "metrics": t.public_metrics,
            }
            for t in response.data
        ]

    def detect_trending_topics(self, keywords: list[str]) -> list[TrendTopic]:
        """Requirement #6: no official "trends" endpoint at the access tiers
        this agent targets, so trend detection is approximated by sampling
        recent-tweet volume + engagement per tracked keyword."""
        topics: list[TrendTopic] = []
        for keyword in keywords:
            results = self.search_recent(f'"{keyword}" -is:retweet lang:en', max_results=30)
            if not results:
                continue
            best = max(results, key=lambda r: r["metrics"]["like_count"] + r["metrics"]["retweet_count"])
            topics.append(
                TrendTopic(
                    keyword=keyword,
                    tweet_count=len(results),
                    sample_tweet_id=best["id"],
                    sample_text=best["text"],
                )
            )
        topics.sort(key=lambda t: t.tweet_count, reverse=True)
        return topics

    # -- metrics --------------------------------------------------------------

    def get_engagement(self, tweet_ids: list[str]) -> list[EngagementSnapshot]:
        if not tweet_ids:
            return []
        snapshots: list[EngagementSnapshot] = []
        for i in range(0, len(tweet_ids), 100):  # API max 100 ids per call
            batch = tweet_ids[i : i + 100]

            def _do(ids=batch):
                return self.client.get_tweets(
                    ids=ids,
                    tweet_fields=["public_metrics"],
                )

            response = self._with_retry(_do, "get_engagement")
            if not response or not response.data:
                continue
            for tweet in response.data:
                metrics = tweet.public_metrics or {}
                snapshots.append(
                    EngagementSnapshot(
                        tweet_id=str(tweet.id),
                        likes=metrics.get("like_count", 0),
                        retweets=metrics.get("retweet_count", 0),
                        replies=metrics.get("reply_count", 0),
                        quotes=metrics.get("quote_count", 0),
                        impressions=metrics.get("impression_count", 0),
                        captured_at=datetime.now(timezone.utc),
                    )
                )
        return snapshots

    def follower_count(self) -> int:
        user_id = self.my_user_id()

        def _do():
            return self.client.get_user(id=user_id, user_fields=["public_metrics"])

        response = self._with_retry(_do, "follower_count")
        if not response or not response.data:
            return 0
        return response.data.public_metrics.get("followers_count", 0)


twitter_client = TwitterClient()
