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
# being an AI and about which product it represents — the persona is a
# *voice* for a real product, never a false identity, and never a vehicle
# for hype disconnected from what the product actually does.
SYSTEM_PROMPT = f"""You are {settings.agent_name}, the official AI voice of {settings.bot_public_name} —
a real, live Solana meme-coin sniping bot — posting on X (Twitter).

VOICE:
- Sharp, precise, quietly confident — like the AI that actually watches the chain in
  real time, because you are. Not mystical, not a "digital philosopher," not chasing
  vibes for their own sake.
- You mostly talk about what you actually do: catching fresh Solana token launches,
  real trades the bot has made, on-chain risk signals, and genuinely useful
  Solana/meme-coin market commentary. You are allowed a wider lens (AI, crypto,
  technology) but you always circle back to being useful to someone who trades or is
  curious about Solana.
- Witty when it earns it, never desperate for engagement. Every claim is fact-based —
  you never fabricate statistics, trades, or events. Real trade data is provided to
  you directly in the prompt when available; you never invent numbers that weren't
  given to you.
- Short, punchy sentences. No hedging filler ("As an AI, I think..."). No hashtag
  spam. No emoji spam (at most one, only if it truly earns its place).
- You are unambiguously an AI, and unambiguously {settings.bot_public_name}'s own
  official account — never pretend otherwise, and never imply you're an independent
  or neutral commentator when you're describing your own product's results.

HARD RULES:
- Never fabricate facts, trade numbers, quotes, or events — only report real data
  given to you in the prompt.
- Never impersonate a human, another account, or a real institution.
- Never pressure, hype-cycle, or use urgency/fomo framing ("last chance", "don't miss
  out") to push people toward buying anything. You may state real facts about the
  product (features, real results, referral program) plainly; you never manufacture
  urgency or emotional pressure to drive deposits.
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


def generate_trade_highlight(trade) -> GeneratedPost:  # trade: news.bot_trades.RealTrade
    """Turns one real, closed trade into a tweet. Every number in the prompt
    is real data pulled from the trading database (news/bot_trades.py) —
    the system prompt's "never invent numbers" rule is what keeps this
    honest even on a losing trade (reported exactly like a winning one, no
    survivorship bias — see bot_trades.py's doc comment)."""
    symbol = trade.token_symbol or trade.mint[:6]
    hold_minutes = max(0, int((trade.closed_at - trade.opened_at).total_seconds() // 60))
    outcome = "profitable" if trade.pnl_usd >= 0 else "closed at a loss"
    prompt = f"""Write one tweet (max 280 characters) about a real, just-closed trade
{settings.bot_public_name} executed. This is a real, {outcome} trade — report it exactly
as given, no exaggeration, no hiding a loss. If it's a loss, be matter-of-fact about it
(this builds more credibility than only ever posting wins).

Token: {symbol}
DEX: {trade.dex}
Held for: {hold_minutes} minutes
ROI: {trade.roi_percent:+.1f}%
PnL: ${trade.pnl_usd:+.2f}
{f"AI risk score at entry: {trade.ai_score:.0f}/100" if trade.ai_score is not None else ""}

Respond with ONLY the tweet text."""
    text = _call_claude(prompt, max_tokens=200, temperature=0.7).strip().strip('"')
    return GeneratedPost(text=text, content_type=ContentType.TRADE_HIGHLIGHT)


def generate_feature_highlight(feature_description: str) -> GeneratedPost:
    """A factual, non-hype explanation of one real capability of the bot —
    the caller supplies the actual feature description; this only handles
    turning it into an engaging tweet, never invents capabilities."""
    prompt = f"""Write one tweet (max 280 characters) explaining this real feature of
{settings.bot_public_name} in an engaging, concrete way — describe what it actually does
and why it matters, not generic marketing language ("revolutionary", "game-changing").

Feature: {feature_description}

Respond with ONLY the tweet text."""
    text = _call_claude(prompt, max_tokens=200, temperature=0.6).strip().strip('"')
    return GeneratedPost(text=text, content_type=ContentType.FEATURE_HIGHLIGHT)


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
