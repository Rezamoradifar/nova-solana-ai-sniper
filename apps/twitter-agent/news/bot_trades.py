"""Real closed-trade data from the actual Nova Solana AI Sniper trading
database — Nova's most credible content source: verifiable, real, on-chain
trades, not generic commentary.

READ-ONLY BY CONSTRUCTION: every query in this module is a SELECT against
Position/Token/Trade. Nothing here ever writes to the trading database —
this process has no ability to affect buy/sell execution, mirroring the
same isolation principle apps/marketing-engine/src/tradeShowcase/data.ts
already established for exactly this reason (a bug in marketing content
generation must never be able to touch trading logic). For defense in
depth, TRADING_DATABASE_URL should point at a Postgres role with SELECT-only
grants, not the trading app's own read/write credentials.

Mirrors apps/marketing-engine/src/tradeShowcase/data.ts's eligibility
filter and ROI computation exactly, so Nova never reports a number that
disagrees with the platform's own public trade showcase.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime

from core.config import settings
from memory import db

logger = logging.getLogger("news.bot_trades")


@dataclass
class RealTrade:
    position_id: str
    mint: str
    token_name: str | None
    token_symbol: str | None
    dex: str
    opened_at: datetime
    closed_at: datetime
    entry_price_usd: float
    pnl_usd: float
    roi_percent: float
    ai_score: float | None


def _get_connection():
    if not settings.trading_database_url:
        return None
    import psycopg2
    import psycopg2.extras

    return psycopg2.connect(settings.trading_database_url, cursor_factory=psycopg2.extras.RealDictCursor)


CANDIDATES_SQL = """
    SELECT p.id AS position_id, p."walletId" AS wallet_id, p."tokenId" AS token_id,
           t.mint, t.name AS token_name, t.symbol AS token_symbol, t.dex,
           p."createdAt" AS opened_at, p."closedAt" AS closed_at,
           p."entryPriceUsd" AS entry_price_usd, p."realizedPnlUsd" AS pnl_usd,
           p."amountSolInvested" AS amount_sol_invested, p."riskScoreAtEntry" AS ai_score
    FROM positions p
    JOIN tokens t ON p."tokenId" = t.id
    WHERE p.status = 'CLOSED'
      AND p."isPaperTrade" = false
      AND p."closedAt" IS NOT NULL
      AND p."realizedPnlUsd" IS NOT NULL
      AND COALESCE(t."isHoneypotSuspected", false) = false
    ORDER BY p."closedAt" DESC
    LIMIT %s
"""

SELL_TOTAL_SQL = """
    SELECT COALESCE(SUM("amountSol"), 0) AS total_sell_sol
    FROM trades
    WHERE "walletId" = %s AND "tokenId" = %s AND side = 'SELL' AND status = 'CONFIRMED'
      AND "createdAt" >= %s
"""


def fetch_recent_real_trades(limit: int = 10) -> list[RealTrade]:
    """Empty list (not an error) whenever TRADING_DATABASE_URL isn't
    configured — trade-highlight content is simply skipped, same as the
    news-rewrite content type is skipped when no fresh news exists."""
    conn = _get_connection()
    if conn is None:
        return []

    trades: list[RealTrade] = []
    try:
        with conn, conn.cursor() as cur:
            cur.execute(CANDIDATES_SQL, (limit,))
            candidates = cur.fetchall()

            for c in candidates:
                invested = float(c["amount_sol_invested"] or 0)
                if invested <= 0:
                    continue
                cur.execute(SELL_TOTAL_SQL, (c["wallet_id"], c["token_id"], c["opened_at"]))
                sell_row = cur.fetchone()
                total_sell_sol = float(sell_row["total_sell_sol"] or 0)
                roi_percent = (total_sell_sol - invested) / invested * 100

                trades.append(
                    RealTrade(
                        position_id=c["position_id"],
                        mint=c["mint"],
                        token_name=c["token_name"],
                        token_symbol=c["token_symbol"],
                        dex=c["dex"],
                        opened_at=c["opened_at"],
                        closed_at=c["closed_at"],
                        entry_price_usd=float(c["entry_price_usd"] or 0),
                        pnl_usd=float(c["pnl_usd"] or 0),
                        roi_percent=roi_percent,
                        ai_score=float(c["ai_score"]) if c["ai_score"] is not None else None,
                    )
                )
    except Exception as err:  # noqa: BLE001 — a DB hiccup must never crash the scheduler loop
        logger.warning("Failed to fetch real trades (skipping this cycle): %s", err)
        return []
    finally:
        conn.close()

    return trades


def _fingerprint(position_id: str) -> str:
    return "trade:" + position_id


def fresh_real_trades(limit: int = 10) -> list[RealTrade]:
    """Same not-yet-used filtering convention as news/rewriter.py's
    fresh_news_items — a trade already tweeted about is never repeated."""
    return [t for t in fetch_recent_real_trades(limit) if not db.idea_already_used(_fingerprint(t.position_id))]


def mark_trade_used(trade: RealTrade) -> None:
    db.mark_idea_used(_fingerprint(trade.position_id))
