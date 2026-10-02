"""Requirement #17: generate tweet images using OpenAI Images "when
appropriate" — i.e. not for every post. The caller decides when an image
adds value (see agent/main.py's should_attach_image)."""

from __future__ import annotations

import logging

import requests
from openai import OpenAI

from core.config import settings

logger = logging.getLogger("llm.images")

_client = OpenAI(api_key=settings.openai_api_key)
IMAGE_MODEL = "gpt-image-1"


def generate_image(prompt: str) -> bytes | None:
    try:
        response = _client.images.generate(
            model=IMAGE_MODEL,
            prompt=prompt,
            size="1024x1024",
            n=1,
        )
        image_data = response.data[0]
        if getattr(image_data, "b64_json", None):
            import base64

            return base64.b64decode(image_data.b64_json)
        if getattr(image_data, "url", None):
            resp = requests.get(image_data.url, timeout=30)
            resp.raise_for_status()
            return resp.content
        return None
    except Exception as err:  # noqa: BLE001 — image gen is best-effort, never blocks a post
        logger.warning("Image generation failed, posting without image: %s", err)
        return None


def should_attach_image(content_type: str) -> bool:
    """Simple heuristic: original thoughts and philosophical threads benefit
    from an evocative image; news rewrites and replies don't need one."""
    return content_type in {"original_thought", "philosophical_thread"}


def build_image_prompt(tweet_text: str) -> str:
    return (
        "Abstract, cinematic, moody digital art evoking this idea — no text or letters in "
        f"the image, no logos: {tweet_text}"
    )
