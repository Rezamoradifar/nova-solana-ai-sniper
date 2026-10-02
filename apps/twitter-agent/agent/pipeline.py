"""The core generate -> score -> dedup -> hashtag -> image -> publish
pipeline. Every scheduled job (agent/scheduler.py) that wants to publish
something routes through `publish_post` so the scoring gate (requirement
#10) and dedup guard (requirement #11) are enforced exactly once, in one
place, for every content type."""

from __future__ import annotations

import logging

from core.config import settings
from core.models import GeneratedPost, ScoreBreakdown
from llm import claude_client, openai_images
from memory import db, vector_store
from twitter.client import twitter_client

logger = logging.getLogger("agent.pipeline")


def score_and_gate(post: GeneratedPost) -> ScoreBreakdown | None:
    """Returns the score if it clears MIN_PUBLISH_SCORE, else None."""
    score = claude_client.score_post(post.text)
    post.score = score
    if score.total < settings.min_publish_score:
        logger.info(
            "Post scored %.1f (< %.1f threshold) — rejected: %r",
            score.total,
            settings.min_publish_score,
            post.text,
        )
        return None
    return score


def generate_with_gate(
    generator_fn,
    *args,
    **kwargs,
) -> GeneratedPost | None:
    """Calls `generator_fn(*args, **kwargs)` up to MAX_GENERATION_ATTEMPTS
    times, rejecting anything that's a near-duplicate of a past post
    (requirement #11/#13) or scores below the publish threshold
    (requirement #10). Returns the first post that clears both gates."""
    for attempt in range(settings.max_generation_attempts):
        post = generator_fn(*args, **kwargs)
        if not post or not post.text:
            continue
        if vector_store.is_duplicate(post.text):
            logger.info("Rejected as near-duplicate (attempt %s): %r", attempt + 1, post.text)
            continue
        score = score_and_gate(post)
        if score is None:
            continue
        return post
    logger.warning("Exhausted %s generation attempts without a publishable post", settings.max_generation_attempts)
    return None


def publish_post(post: GeneratedPost) -> str | None:
    """Applies hashtag optimization (#16), optional image generation (#17),
    thread handling (#18), persists to memory + the vector index, and
    actually posts to X."""
    hashtags = claude_client.suggest_hashtags(post.text, settings.max_hashtags)
    final_text = post.text
    if hashtags:
        tag_str = " " + " ".join(f"#{tag}" for tag in hashtags)
        if len(final_text) + len(tag_str) <= 280:
            final_text += tag_str

    image_bytes = None
    if openai_images.should_attach_image(post.content_type.value):
        image_prompt = openai_images.build_image_prompt(post.text)
        image_bytes = openai_images.generate_image(image_prompt)

    if post.thread_parts and len(post.thread_parts) > 1:
        posted_ids = twitter_client.post_thread(post.thread_parts)
        tweet_id = posted_ids[0] if posted_ids else None
    else:
        tweet_id = twitter_client.post_tweet(final_text, image_bytes=image_bytes)

    if not tweet_id:
        logger.error("Failed to publish post: %r", post.text)
        return None

    post_row_id = db.save_post(
        tweet_id=tweet_id,
        content_type=post.content_type.value,
        text=final_text,
        hashtags=hashtags,
        source_url=post.source_url,
        score_total=post.score.total if post.score else None,
        score_breakdown=post.score.__dict__ if post.score else None,
    )
    vector_store.index_post(post_row_id, post.text)
    logger.info("Published tweet %s (%s): %r", tweet_id, post.content_type.value, final_text)
    return tweet_id
