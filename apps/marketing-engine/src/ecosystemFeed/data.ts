import type { PrismaClient } from '@prisma/client';
import { resolveShowcaseTradeByPositionId, type ShowcaseTrade } from '../tradeShowcase/data.js';

/**
 * Ecosystem Feed (2026-07-31) — data layer for the 5 Phase 1 categories
 * (Trending Tokens, Smart Money Trades, High Volume Tokens, Hidden Gems,
 * Biggest Winners). Same isolation principle as ../activityFeed/data.ts and
 * ../tradeShowcase/data.ts: lives in apps/marketing-engine, the only table
 * this ever writes to is its own dedup marker (ActivityFeedPost, shared with
 * activityFeed but under a distinct, prefixed feedType namespace so the two
 * feeds' dedup rows can never collide or be confused), and it has no path
 * that can affect buy/sell execution.
 *
 * "Trending Tokens" and "High Volume Tokens" both draw from a wider
 * candidate pool than activityFeed's own TRENDING_TOKEN: the bot's own
 * detected-token pool (Token table) PLUS mints discovered via the
 * discovery/telegramTrend.ts scraper. A Telegram-discovered mint never gets
 * a Token row written for it (that table is apps/api's own live detection
 * cursor — see discovery/telegramTrend.ts's own doc comment for why) — its
 * dedup refId is the mint address itself, day-bucketed, instead of a tokenId.
 */

const ECOSYSTEM_FEED_TYPES = {
  TRENDING_TOKEN: 'ECOSYSTEM_TRENDING_TOKEN',
  SMART_MONEY_TRADE: 'ECOSYSTEM_SMART_MONEY_TRADE',
  HIGH_VOLUME_TOKEN: 'ECOSYSTEM_HIGH_VOLUME_TOKEN',
  HIDDEN_GEM: 'ECOSYSTEM_HIDDEN_GEM',
  BIGGEST_WINNER: 'ECOSYSTEM_BIGGEST_WINNER',
} as const;

export type EcosystemFeedType = (typeof ECOSYSTEM_FEED_TYPES)[keyof typeof ECOSYSTEM_FEED_TYPES];

export { ECOSYSTEM_FEED_TYPES };

/** Same MIN_WHALE_CONFIDENCE convention as activityFeed/data.ts — only show
 * a wallet once the tracker has enough real sample history to be confident
 * about it. */
const MIN_SMART_MONEY_CONFIDENCE = 50;
const TRENDING_LOOKBACK_HOURS = 24;
const HIGH_VOLUME_LOOKBACK_HOURS = 24;
const HIDDEN_GEM_LOOKBACK_HOURS = 48;

/** Same shared-dedup-join pattern as activityFeed/data.ts's filterUnposted —
 * deliberately a separate function/copy (not imported from activityFeed) so
 * the two modules can evolve independently, even though both read the same
 * physical ActivityFeedPost table. */
async function filterUnposted(
  prisma: PrismaClient,
  feedType: EcosystemFeedType,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const posted = await prisma.activityFeedPost.findMany({
    where: { feedType, refId: { in: ids } },
    select: { refId: true },
  });
  const postedIds = new Set(posted.map((p) => p.refId));
  return new Set(ids.filter((id) => !postedIds.has(id)));
}

export async function markEcosystemFeedPosted(
  prisma: PrismaClient,
  feedType: EcosystemFeedType,
  refId: string,
): Promise<void> {
  await prisma.activityFeedPost.create({ data: { feedType, refId } });
}

/** Has this exact mint already been checked/posted (or rejected) for this
 * feed type today? Used to avoid re-verifying (DexScreener + RPC risk score)
 * the same Telegram-discovered candidate on every tick. */
export async function isMintAlreadyHandledToday(
  prisma: PrismaClient,
  feedType: EcosystemFeedType,
  mint: string,
  now: Date,
): Promise<boolean> {
  const existing = await prisma.activityFeedPost.findUnique({
    where: { feedType_refId: { feedType, refId: `${mint}:${utcDayKeyForDedup(now)}` } },
  });
  return existing !== null;
}

function utcDayKeyForDedup(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Day-bucketed dedup refId for a Telegram-discovered mint (no Token row —
 * see this module's own doc comment for why). */
export function mintDedupRefId(mint: string, now: Date): string {
  return `${mint}:${utcDayKeyForDedup(now)}`;
}

export interface EcosystemDbTokenCandidate {
  /** Already the day-bucketed dedup key (`${tokenId}:${dayKey}`). */
  id: string;
  tokenId: string;
  mint: string;
  name: string | undefined;
  symbol: string | undefined;
  dex: string;
  detectedAt: Date;
  liquidityUsd: number | undefined;
  marketCapUsd: number | undefined;
  /** Real AI score already computed by the live buy-evaluation pipeline for
   * this token (Token.aiScore) — shown as-is when present; NOT recomputed
   * here (no LLM call for display purposes, per project plan). */
  aiScore: number | undefined;
  /** These three plus liquidityUsd above are exactly discovery/riskScore.ts's
   * EcosystemRiskFlags shape — already stored on Token from when the bot's
   * live pipeline evaluated it, so the monitor can call
   * computeEcosystemRiskScore for a DB-sourced candidate at zero extra RPC
   * cost, unlike a Telegram-discovered candidate (no Token row, needs a real
   * scoreTokenRisk RPC read). */
  mintAuthorityRevoked: boolean | undefined;
  freezeAuthorityRevoked: boolean | undefined;
  top10HolderPercent: number | undefined;
}

async function fetchDayBucketedTokenCandidates(
  prisma: PrismaClient,
  feedType: EcosystemFeedType,
  limit: number,
  lookbackHours: number,
  deployedAt: Date,
  now: Date,
  extraWhere: Record<string, unknown> = {},
): Promise<EcosystemDbTokenCandidate[]> {
  const windowStart = new Date(
    Math.max(deployedAt.getTime(), now.getTime() - lookbackHours * 60 * 60 * 1000),
  );
  const candidates = await prisma.token.findMany({
    where: { firstSeenAt: { gte: windowStart }, ...extraWhere },
    orderBy: { firstSeenAt: 'desc' },
    take: limit * 4,
  });
  const dayKey = utcDayKeyForDedup(now);
  const refIds = candidates.map((t) => `${t.id}:${dayKey}`);
  const unposted = await filterUnposted(prisma, feedType, refIds);
  return candidates
    .filter((t) => unposted.has(`${t.id}:${dayKey}`))
    .slice(0, limit)
    .map((t) => ({
      id: `${t.id}:${dayKey}`,
      tokenId: t.id,
      mint: t.mint,
      name: t.name ?? undefined,
      symbol: t.symbol ?? undefined,
      dex: t.dex,
      detectedAt: t.firstSeenAt,
      liquidityUsd: t.liquidityUsd ?? undefined,
      marketCapUsd: t.marketCapUsd ?? undefined,
      aiScore: t.aiScore ?? undefined,
      mintAuthorityRevoked: t.mintAuthorityRevoked ?? undefined,
      freezeAuthorityRevoked: t.freezeAuthorityRevoked ?? undefined,
      top10HolderPercent: t.top10HolderPercent ?? undefined,
    }));
}

/** Rolling pool of bot-detected tokens eligible to be *checked* for a live
 * trending signal — mirrors activityFeed's fetchTrendingTokenDbCandidates
 * exactly, but under this module's own feedType/dedup namespace so the two
 * "Trending Token" posts (activityFeed's plain-text one, this one's
 * image+buttons one) never collide or suppress each other. The caller
 * (monitor.ts) merges this with discovery/telegramTrend.ts-sourced
 * candidates before applying the live DexScreener/risk-score gate. */
export async function fetchTrendingTokenDbCandidates(
  prisma: PrismaClient,
  limit: number,
  deployedAt: Date,
  now: Date,
): Promise<EcosystemDbTokenCandidate[]> {
  return fetchDayBucketedTokenCandidates(
    prisma,
    ECOSYSTEM_FEED_TYPES.TRENDING_TOKEN,
    limit,
    TRENDING_LOOKBACK_HOURS,
    deployedAt,
    now,
  );
}

/** Same DB pool shape as Trending Tokens — "high volume" among tokens our
 * own scanner has already detected, NOT a market-wide external scan (no such
 * capability exists — see project plan). The caller still has to fetch each
 * mint's live DexScreener volume and apply ECOSYSTEM_FEED_MIN_VOLUME_USD;
 * this is the raw candidate pool only. */
export async function fetchHighVolumeDbCandidates(
  prisma: PrismaClient,
  limit: number,
  deployedAt: Date,
  now: Date,
): Promise<EcosystemDbTokenCandidate[]> {
  return fetchDayBucketedTokenCandidates(
    prisma,
    ECOSYSTEM_FEED_TYPES.HIGH_VOLUME_TOKEN,
    limit,
    HIGH_VOLUME_LOOKBACK_HOURS,
    deployedAt,
    now,
  );
}

/** marketCapUsd/liquidityUsd are guaranteed defined here (the query below
 * requires both), unlike the base type's optional fields. */
export interface HiddenGemCandidate extends EcosystemDbTokenCandidate {
  marketCapUsd: number;
  liquidityUsd: number;
}

/** Small-cap, above-safety-floor tokens — stricter than activityFeed's
 * NEW_OPPORTUNITY (which has no cap/liquidity filter at all). Filtered
 * server-side since Token already stores real, already-fetched
 * marketCapUsd/liquidityUsd for any evaluated token (no extra live call
 * needed here, unlike Trending/High Volume). */
export async function fetchHiddenGemCandidates(
  prisma: PrismaClient,
  limit: number,
  deployedAt: Date,
  now: Date,
  maxMarketCapUsd: number,
): Promise<HiddenGemCandidate[]> {
  const windowStart = new Date(
    Math.max(deployedAt.getTime(), now.getTime() - HIDDEN_GEM_LOOKBACK_HOURS * 60 * 60 * 1000),
  );
  const candidates = await prisma.token.findMany({
    where: {
      firstSeenAt: { gte: windowStart },
      marketCapUsd: { not: null, lte: maxMarketCapUsd, gt: 0 },
      liquidityUsd: { not: null, gt: 0 },
      isHoneypotSuspected: { not: true },
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
    },
    orderBy: { firstSeenAt: 'desc' },
    take: limit * 4,
  });
  const dayKey = utcDayKeyForDedup(now);
  const refIds = candidates.map((t) => `${t.id}:${dayKey}`);
  const unposted = await filterUnposted(prisma, ECOSYSTEM_FEED_TYPES.HIDDEN_GEM, refIds);
  return candidates
    .filter((t) => unposted.has(`${t.id}:${dayKey}`))
    .slice(0, limit)
    .map((t) => ({
      id: `${t.id}:${dayKey}`,
      tokenId: t.id,
      mint: t.mint,
      name: t.name ?? undefined,
      symbol: t.symbol ?? undefined,
      dex: t.dex,
      detectedAt: t.firstSeenAt,
      marketCapUsd: t.marketCapUsd as number,
      liquidityUsd: t.liquidityUsd as number,
      aiScore: t.aiScore ?? undefined,
      // Guaranteed true by this query's own where-clause above.
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      top10HolderPercent: t.top10HolderPercent ?? undefined,
    }));
}

export interface SmartMoneyTradeCandidate {
  id: string;
  walletAddress: string;
  mint: string;
  tokenName: string | undefined;
  tokenSymbol: string | undefined;
  confidenceScore: number;
  winRate: number | undefined;
  medianRoiPercent: number | undefined;
  entryMarketCapUsd: number | undefined;
  entryAt: Date;
}

/** Real smart-wallet entries with enough sample history to be confident
 * about (see MIN_SMART_MONEY_CONFIDENCE) — same underlying source data as
 * activityFeed's WHALE_ALERT, correctly relabeled: SmartWallet.confidenceScore
 * is win-rate/ROI-history based, not balance/size-based, so "Smart Money" is
 * the accurate name (true balance-based "Whale" detection doesn't exist yet
 * — see project plan's Phase 2). Separate feedType/dedup namespace from
 * activityFeed's WHALE_ALERT so both can post independently. */
export async function fetchSmartMoneyTradeCandidates(
  prisma: PrismaClient,
  limit: number,
  deployedAt: Date,
): Promise<SmartMoneyTradeCandidate[]> {
  const candidates = await prisma.smartWalletTokenEntry.findMany({
    where: {
      entryAt: { gte: deployedAt },
      wallet: { confidenceScore: { gte: MIN_SMART_MONEY_CONFIDENCE } },
    },
    include: { wallet: true, token: true },
    orderBy: { entryAt: 'desc' },
    take: limit * 4,
  });
  const unposted = await filterUnposted(
    prisma,
    ECOSYSTEM_FEED_TYPES.SMART_MONEY_TRADE,
    candidates.map((c) => c.id),
  );
  return candidates
    .filter((c) => unposted.has(c.id) && c.wallet.confidenceScore !== null)
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      walletAddress: c.walletAddress,
      mint: c.mint,
      tokenName: c.token?.name ?? undefined,
      tokenSymbol: c.token?.symbol ?? undefined,
      confidenceScore: c.wallet.confidenceScore as number,
      winRate: c.wallet.winRate ?? undefined,
      medianRoiPercent: c.wallet.medianRoiPercent ?? undefined,
      entryMarketCapUsd: c.entryMarketCapUsd ?? undefined,
      entryAt: c.entryAt,
    }));
}

/** Real closed positions (the bot's own trades), best pnlUsd first, not yet
 * posted to this category — folds "Biggest Profit"/"Biggest ROI"/"Biggest
 * Winners" into one leaderboard (see project plan for why). One-shot dedup
 * (refId = positionId, no day-bucketing) since a position only ever closes
 * once. Reuses tradeShowcase/data.ts's resolveShowcaseTradeByPositionId for
 * the actual ROI/pnl/signature resolution — same real numbers, one source of
 * truth, independent of tradeShowcase's own showcasePostedAt dedup marker
 * (a trade can be posted to both features on its own schedule). */
export async function fetchBiggestWinnerCandidates(
  prisma: PrismaClient,
  limit: number,
  deployedAt: Date,
): Promise<ShowcaseTrade[]> {
  const positions = await prisma.position.findMany({
    where: {
      status: 'CLOSED',
      isPaperTrade: false,
      closedAt: { not: null, gte: deployedAt },
      realizedPnlUsd: { not: null, gt: 0 },
      token: { isHoneypotSuspected: { not: true } },
    },
    orderBy: { realizedPnlUsd: 'desc' },
    take: limit * 4,
  });
  const unposted = await filterUnposted(
    prisma,
    ECOSYSTEM_FEED_TYPES.BIGGEST_WINNER,
    positions.map((p) => p.id),
  );
  const eligible = positions.filter((p) => unposted.has(p.id)).slice(0, limit);
  const resolved = await Promise.all(
    eligible.map((p) => resolveShowcaseTradeByPositionId(prisma, p.id)),
  );
  return resolved.filter((t): t is ShowcaseTrade => t !== undefined);
}
