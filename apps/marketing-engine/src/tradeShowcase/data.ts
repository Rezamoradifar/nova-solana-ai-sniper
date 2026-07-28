import type { PrismaClient } from '@prisma/client';

/**
 * Daily Trade Showcase (2026-07-27) — read-only view over the trading DB's
 * real closed positions. This module never writes to Trade/Position beyond
 * the two dedup markers it owns (Position.showcasePostedAt,
 * TradeShowcaseDailySummary) — it has no ability to affect trading logic,
 * deliberately: this lives in apps/marketing-engine, not apps/api, so a bug
 * here can never touch buy/sell execution.
 *
 * Deliberately reports every eligible trade as-is — no profit-range filter,
 * no fixed count, wins and losses both included. The only exclusions are
 * data-integrity ones (see isShowcaseEligible below), never "does this look
 * good" ones — that selection bias is exactly what a transparent showcase
 * exists to avoid.
 */
export interface ShowcaseTrade {
  positionId: string;
  mint: string;
  tokenName: string | undefined;
  tokenSymbol: string | undefined;
  dex: string;
  buyAt: Date;
  sellAt: Date;
  entryPriceUsd: number;
  exitPriceUsd: number | undefined;
  /** ROI on SOL actually put in vs SOL actually returned — mirrors
   * apps/api/src/trading/positionManager.ts's own closePosition roiPercent
   * computation (Profit Distribution Audit, 2026-07-12 fix: sums every
   * CONFIRMED SELL trade since position open, not just the final leg, so a
   * position with prior partial exits isn't understated). */
  roiPercent: number;
  pnlUsd: number;
  buySignature: string | undefined;
  sellSignature: string | undefined;
  /** The AI/risk score Nova's scanner assigned this token at entry —
   * Position.riskScoreAtEntry, the same field the real-time "buy" event uses
   * elsewhere (see activityFeed's now-retired BuyExecutedCandidate). Required
   * by the "Real Bot Trade" post spec (2026-07-28). */
  aiScore: number | undefined;
}

/** Data-integrity-only exclusions — never a "does this trade look good"
 * filter. isPaperTrade: the spec requires real on-chain transactions only.
 * token.isHoneypotSuspected: showcasing a security-flagged token as a normal
 * trade (win OR loss) misrepresents it regardless of its P&L.
 *
 * `deployedAt` (2026-07-27 correction): every query here is permanently
 * bounded to `closedAt >= deployedAt` — pre-existing trade history is never
 * eligible, not just skipped once. See TRADE_SHOWCASE_DEPLOYED_AT's own
 * env.ts doc comment for why this must be a fixed, pinned cutoff rather than
 * "now" recomputed on every call. */
async function fetchCandidatePositions(prisma: PrismaClient, limit: number, deployedAt: Date) {
  return prisma.position.findMany({
    where: {
      status: 'CLOSED',
      isPaperTrade: false,
      showcasePostedAt: null,
      closedAt: { not: null, gte: deployedAt },
      realizedPnlUsd: { not: null },
      token: { isHoneypotSuspected: { not: true } },
    },
    include: { token: true },
    orderBy: { closedAt: 'asc' },
    take: limit,
  });
}

/**
 * Resolves buy/sell tx signatures and real ROI for one closed position.
 * Mirrors positionManager.ts's closePosition best-effort Trade lookup
 * exactly (no Trade->Position FK exists in the schema — see Trade's own doc
 * comment) rather than inventing a second, possibly-divergent computation:
 * most recent BUY trade for this wallet+token as the buy leg, every
 * CONFIRMED SELL trade since the position opened summed for the real
 * SOL-in/SOL-out ROI (correct across partial-exit positions too).
 */
async function resolveTradeDetails(
  prisma: PrismaClient,
  position: Awaited<ReturnType<typeof fetchCandidatePositions>>[number],
): Promise<ShowcaseTrade | undefined> {
  const [buyTrade, sellTrades] = await Promise.all([
    prisma.trade.findFirst({
      where: { walletId: position.walletId, tokenId: position.tokenId, side: 'BUY' },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.trade.findMany({
      where: {
        walletId: position.walletId,
        tokenId: position.tokenId,
        side: 'SELL',
        status: 'CONFIRMED',
        createdAt: { gte: position.createdAt },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  // No confirmed sell trade to point to — can't build a truthful "sell tx
  // link" for this position, so it's skipped rather than shown with a
  // missing/fabricated link. Will simply be picked up once the data is
  // consistent (showcasePostedAt stays null).
  const lastSellTrade = sellTrades.at(-1);
  if (!lastSellTrade || !position.closedAt) return undefined;

  const totalSellAmountSol = sellTrades.reduce((sum, t) => sum + t.amountSol, 0);
  const totalProfitSol = totalSellAmountSol - position.amountSolInvested;
  const roiPercent =
    position.amountSolInvested > 0 ? (totalProfitSol / position.amountSolInvested) * 100 : 0;

  return {
    positionId: position.id,
    mint: position.token.mint,
    tokenName: position.token.name ?? undefined,
    tokenSymbol: position.token.symbol ?? undefined,
    dex: position.token.dex,
    buyAt: buyTrade?.createdAt ?? position.createdAt,
    sellAt: position.closedAt,
    entryPriceUsd: position.entryPriceUsd,
    exitPriceUsd: lastSellTrade.priceUsd ?? undefined,
    roiPercent,
    pnlUsd: position.realizedPnlUsd ?? 0,
    buySignature: buyTrade?.txSignature ?? undefined,
    sellSignature: lastSellTrade.txSignature ?? undefined,
    aiScore: position.riskScoreAtEntry ?? undefined,
  };
}

/** Fetches up to `limit` real, showcase-eligible closed trades that haven't
 * been posted yet and closed on/after `deployedAt`, oldest-closed first (so
 * a backlog of NEW trades drains in the order they actually happened, not
 * newest-first) — pre-deployment history is never included, see
 * fetchCandidatePositions' own doc comment. */
export async function fetchShowcaseEligibleTrades(
  prisma: PrismaClient,
  limit: number,
  deployedAt: Date,
): Promise<ShowcaseTrade[]> {
  const candidates = await fetchCandidatePositions(prisma, limit, deployedAt);
  const resolved = await Promise.all(candidates.map((p) => resolveTradeDetails(prisma, p)));
  return resolved.filter((t): t is ShowcaseTrade => t !== undefined);
}

/** Every user who has ever started the bot (telegramId set) — the DM
 * audience for the real-trade broadcast (2026-07-28): every completed real
 * bot trade is sent directly to each of these chats, in addition to the
 * public channel post, independent of whether the user has an active
 * sniper config. */
export async function fetchSubscribedTelegramIds(prisma: PrismaClient): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { telegramId: { not: null } },
    select: { telegramId: true },
  });
  return users.map((u) => u.telegramId!);
}

/** Marks a trade as posted — the per-trade dedup guard (Position.showcasePostedAt). */
export async function markTradeShowcased(prisma: PrismaClient, positionId: string): Promise<void> {
  await prisma.position.update({
    where: { id: positionId },
    data: { showcasePostedAt: new Date() },
  });
}

/** Every trade whose sell closed within the given UTC day, used for the
 * once-per-day aggregate summary — independent of showcasePostedAt (the
 * summary reports the day's true totals regardless of per-trade posting
 * order/backlog, and re-running it for an already-summarized day is guarded
 * separately by TradeShowcaseDailySummary's unique constraint, not by this
 * query). Same isPaperTrade/isHoneypotSuspected exclusions as the per-trade
 * feed, for the same reason: those aren't real, representable trades.
 */
export async function fetchClosedTradesForDay(
  prisma: PrismaClient,
  dayStartUtc: Date,
  dayEndUtc: Date,
): Promise<ShowcaseTrade[]> {
  const positions = await prisma.position.findMany({
    where: {
      status: 'CLOSED',
      isPaperTrade: false,
      closedAt: { gte: dayStartUtc, lt: dayEndUtc },
      realizedPnlUsd: { not: null },
      token: { isHoneypotSuspected: { not: true } },
    },
    include: { token: true },
    orderBy: { closedAt: 'asc' },
  });
  const resolved = await Promise.all(positions.map((p) => resolveTradeDetails(prisma, p)));
  return resolved.filter((t): t is ShowcaseTrade => t !== undefined);
}
