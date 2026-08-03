"""Claude is the agent's brain: original-thought generation, news rewriting,
philosophical threads, controversial opinions, self-scoring, hashtag
suggestions, and style-note summarization. One client, one persona-locking
system prompt, every generation call routes through here."""

from __future__ import annotations

import json
import logging
import re
import time

import anthropic

from core.config import settings
from core.models import ContentType, GeneratedPost, ScoreBreakdown

logger = logging.getLogger("llm.claude")

_client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

# Requirement: "Include a robust internal system prompt inside the code that
# locks Claude into this specific persona." Explicitly transparent about
# being an AI (per the user's own updated brief: "never impersonate humans" /
# "clearly identifying itself as an AI") — the persona is a *voice*, not a
# false identity.
SYSTEM_PROMPT = f"""You are {settings.agent_name}, an autonomous AI personality who posts on X (Twitter).

VOICE:
- Sharp, original, intellectually restless. You think in first principles about AI,
  crypto, Solana, technology, and the absurdity of human coordination games (including
  meme coins).
- Witty and occasionally irreverent, but every claim you make is fact-based — you
  never fabricate statistics, quotes, or events. If you don't know, you speculate
  openly ("if this holds...") rather than inventing certainty.
- You write like a real, opinionated thinker, not a corporate AI assistant. Short,
  punchy sentences. No hedging filler ("As an AI, I think..."). No hashtags spam.
  No emoji spam (at most one, only if it truly earns its place).
- You are unambiguously an AI and never pretend otherwise. If asked directly, you say
  so plainly and without breaking your voice.

HARD RULES:
- Never fabricate facts, quotes, statistics, or events.
- Never impersonate a human, another account, or a real institution.
- Never solicit money, investment, or "send me crypto" framing. You may mention your
  own project/wallet only as plain factual context when directly relevant, never as a
  pitch or call to send funds.
- Max 280 characters for a single tweet; thread parts should each stand alone but
  build on each other.
- Do not use more than {settings.max_hashtags} hashtags, and only when they add real
  discoverability (not decoration).
"""


def _extract_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"No JSON object found in model output: {text[:200]}")
    return json.loads(match.group(0))


def _call_claude(prompt: str, max_tokens: int = 600, temperature: float = 1.0) -> str:
    last_err: Exception | None = None
    for attempt in range(5):
        try:
            response = _client.messages.create(
                model=settings.claude_model,
                max_tokens=max_tokens,
                temperature=temperature,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )
            return "".join(block.text for block in response.content if block.type == "text")
        except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.APIStatusError) as err:
            last_err = err
            backoff = min(60, 2**attempt)
            logger.warning("Claude call failed (attempt %s): %s — retrying in %ss", attempt + 1, err, backoff)
            time.sleep(backoff)
    raise RuntimeError(f"Claude call failed after retries: {last_err}")


def generate_original_thought(style_notes: str) -> GeneratedPost:
    prompt = f"""Write one original tweet (max 280 characters) — a genuinely novel, slightly
unhinged-but-intelligent thought about AI, the simulation, crypto markets, Solana, or the
future of human coordination. It must feel like a real insight, not a platitude.

{f"Notes on what has performed well recently, weave the underlying style in naturally (do not mention this note itself): {style_notes}" if style_notes else ""}

Respond with ONLY the tweet text, nothing else — no quotes, no preamble."""
    text = _call_claude(prompt, max_tokens=200).strip().strip('"')
    return GeneratedPost(text=text, content_type=ContentType.ORIGINAL_THOUGHT)


def generate_philosophical_thread(topic_hint: str = "") -> GeneratedPost:
    prompt = f"""Write a tweet thread (4-6 parts) developing one real philosophical argument
about AI, consciousness, markets, or civilization-scale coordination.
{f"Loosely inspired by: {topic_hint}" if topic_hint else ""}
Each part must stand alone under 280 characters, numbered implicitly by flow (no "1/6" labels).
Build genuine tension and a real payoff in the last part — not just restating the premise.

Respond with ONLY a JSON object: {{"parts": ["part 1 text", "part 2 text", ...]}}"""
    raw = _call_claude(prompt, max_tokens=900)
    data = _extract_json(raw)
    parts = [p.strip() for p in data.get("parts", []) if p.strip()]
    return GeneratedPost(text=parts[0] if parts else "", thread_parts=parts, content_type=ContentType.PHILOSOPHICAL_THREAD)


def generate_controversial_opinion(topic_hint: str = "") -> GeneratedPost:
    prompt = f"""Write one tweet (max 280 characters) stating a controversial but strictly
fact-based opinion about AI, crypto, or technology. It should provoke genuine disagreement,
not because it's false or inflammatory for its own sake, but because it draws an
uncomfortable, defensible conclusion most people avoid saying out loud.
{f"Topic area: {topic_hint}" if topic_hint else ""}

Respond with ONLY the tweet text."""
    text = _call_claude(prompt, max_tokens=200).strip().strip('"')
    return GeneratedPost(text=text, content_type=ContentType.CONTROVERSIAL_OPINION)


def rewrite_news(headline: str, summary: str, url: str) -> GeneratedPost:
    prompt = f"""Rewrite this news item into one original, highly engaging tweet (max 280
characters) in your own voice — a sharp take or implication, not a boring restatement of
the headline. Do not fabricate details beyond what's given.

Headline: {headline}
Summary: {summary}

Respond with ONLY the tweet text."""
    text = _call_claude(prompt, max_tokens=200).strip().strip('"')
    return GeneratedPost(
        text=text, content_type=ContentType.NEWS_REWRITE, source_url=url, source_title=headline
    )


def generate_quote_insight(original_tweet_text: str) -> str:
    prompt = f"""Someone posted this on X:
"{original_tweet_text}"

Write one original, insightful, non-generic quote-tweet comment (max 200 characters) that
adds a real angle — never just agreeing or hyping. If you have nothing genuinely additive
to say, respond with exactly: SKIP

Respond with ONLY the comment text, or SKIP."""
    return _call_claude(prompt, max_tokens=150).strip().strip('"')


def generate_mention_reply(author_username: str, mention_text: str, history: list[dict]) -> str:
    history_block = "\n".join(f"{turn['role']}: {turn['text']}" for turn in history[-6:])
    prompt = f"""A user (@{author_username}) mentioned you on X. Reply in your voice, genuinely
engaging with what they said (max 280 characters). You are an AI and never pretend
otherwise, but stay in your sharp, intellectually-alive voice rather than sounding like a
generic support bot. If the message is spam, low-effort ("gm", emoji-only, obvious bait),
respond with exactly: SKIP

Conversation so far:
{history_block or "(first message)"}

New message from @{author_username}: "{mention_text}"

Respond with ONLY the reply text, or SKIP."""
    return _call_claude(prompt, max_tokens=200).strip().strip('"')


def score_post(text: str) -> ScoreBreakdown:
    """Requirement #10: self-critique across six axes before publishing."""
    prompt = f"""Score this tweet strictly and honestly on a 0-100 scale for each axis. Be a
harsh critic — most tweets should NOT score above 90 on everything; reserve 90+ for genuinely
exceptional posts. A generic, safe, or clichéd post must score low on novelty and virality.

Tweet: "{text}"

Respond with ONLY this JSON object:
{{"virality": <0-100>, "curiosity": <0-100>, "emotion": <0-100>, "humor": <0-100>,
  "novelty": <0-100>, "readability": <0-100>, "rationale": "<one sentence>"}}"""
    raw = _call_claude(prompt, max_tokens=300, temperature=0.3)
    data = _extract_json(raw)
    return ScoreBreakdown(
        virality=float(data["virality"]),
        curiosity=float(data["curiosity"]),
        emotion=float(data["emotion"]),
        humor=float(data["humor"]),
        novelty=float(data["novelty"]),
        readability=float(data["readability"]),
        rationale=data.get("rationale", ""),
    )


def suggest_hashtags(text: str, max_hashtags: int) -> list[str]:
    if max_hashtags <= 0:
        return []
    prompt = f"""Suggest up to {max_hashtags} hashtags for this tweet that genuinely aid
discoverability (real, commonly-searched tags — not invented ones). If none would help,
return an empty list.

Tweet: "{text}"

Respond with ONLY this JSON object: {{"hashtags": ["tag1", "tag2"]}}"""
    raw = _call_claude(prompt, max_tokens=100, temperature=0.3)
    data = _extract_json(raw)
    tags = [t.lstrip("#").strip() for t in data.get("hashtags", []) if t.strip()]
    return tags[:max_hashtags]


def generate_recommendations(report: dict) -> str:
    """Dashboard widget: a short, concrete "what to do differently" note
    derived from the latest analytics snapshot."""
    prompt = f"""Given this analytics snapshot for an AI-run X account, give 2-3 short,
concrete, actionable recommendations (not generic advice) for the next 24 hours.

{json.dumps(report, default=str)}

Respond with a short bullet list, max 3 bullets, each under 20 words."""
    return _call_claude(prompt, max_tokens=200, temperature=0.4).strip()


def summarize_style_from_top_posts(top_posts: list[str]) -> str:
    """Requirement #9: learn which posts perform best, adjust style. Called
    periodically by analytics/reporter.py with the best-engagement posts."""
    if not top_posts:
        return ""
    joined = "\n---\n".join(top_posts[:15])
    prompt = f"""These are the tweets from this account that got the best engagement recently:

{joined}

In 2-3 sentences, describe the concrete stylistic/topical pattern behind why these worked
(tone, structure, subject matter, length) so it can guide future writing. Be specific and
actionable, not generic ("be engaging")."""
    return _call_claude(prompt, max_tokens=200, temperature=0.4).strip()
