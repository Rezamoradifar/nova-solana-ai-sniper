import type { PrismaClient } from '@prisma/client';

/**
 * Premium Real-Data Telegram Activity Feed (2026-07-28 rebrand of the
 * 2026-07-27 real-data-only build) — every fetcher here reads real rows only
 * (Token, SmartWalletTokenEntry, ShadowModeDecisionLog) and never invents a
 * value. A fetcher returning an empty array means exactly that: nothing real
 * and unposted exists yet — see monitor.ts/scheduler.ts for why that's
 * allowed to result in "post nothing this tick" rather than falling back to
 * simulated content.
 *
 * Categories map onto the six feed types below; "Real Bot Trade" and "Daily
 * Performance" are the other two spec categories and are posted by the
 * sibling ../tradeShowcase module instead (it already owns its own
 * closed-trade dedup via Position.showcasePostedAt) — not duplicated here.
 *
 * Same isolation principle as ../tradeShowcase/data.ts: lives in
 * apps/marketing-engine, not apps/api, and the only table this ever writes
 * to is its own dedup marker (ActivityFeedPost) — it has no path that can
 * affect buy/sell execution.
 */

const FEED_TYPES = {
  NEW_OPPORTUNITY: 'NEW_OPPORTUNITY',
  MARKET_ACTIVITY: 'MARKET_ACTIVITY',
  TRENDING_TOKEN: 'TRENDING_TOKEN',
  WHALE_ALERT: 'WHALE_ALERT',
  SECURITY_ALERT: 'SECURITY_ALERT',
  WEEKLY_SUMMARY: 'WEEKLY_SUMMARY',
} as const;

export type ActivityFeedType = (typeof FEED_TYPES)[keyof typeof FEED_TYPES];

export { FEED_TYPES };

/** Real smart-wallet accumulation is only shown once the tracker has enough
 * samples to be confident about the wallet — see SmartWallet.confidenceScore's
 * own schema doc comment (null until MIN_SAMPLE_SIZE_FOR_CONFIDENCE resolved
 * entries exist). Filters out low-signal/unscored entries rather than
 * showing a wallet nobody has evidence about yet. */
const MIN_WHALE_CONFIDENCE = 50;

/** How far back a token stays eligible for the rolling "Market Activity" /
 * "Trending Token" pools — bounds both query size and how many live
 * DexScreener checks a tick can trigger; a token detected long ago simply
 * ages out of candidacy for these two categories (it already had its one
 * "New Opportunity" post). */
const MARKET_ACTIVITY_LOOKBACK_HOURS = 48;
const TRENDING_TOKEN_LOOKBACK_HOURS = 24;

/** Given a batch of candidate row ids for one feed type, returns only the
 * ones not yet recorded in ActivityFeedPost — the shared dedup join every
 * fetcher below uses instead of a per-source-table marker column (see
 * ActivityFeedPost's own schema doc comment for why one shared table). */
async function filterUnposted(
  prisma: PrismaClient,
  feedType: ActivityFeedType,
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

/** Marks one real event as posted — the per-event dedup guard. */
export async function markActivityFeedPosted(
  prisma: PrismaClient,
  feedType: ActivityFeedType,
  refId: string,
): Promise<void> {
  await prisma.activityFeedPost.create({ data: { feedType, refId } });
}

/** UTC calendar-day bucket key, used by MARKET_ACTIVITY/TRENDING_TOKEN's
 * dedup refId (`${tokenId}:${dayKey}`) — requirement #11 ("avoid reposting
 * the same token within 24 hours"): a token can resurface in one of these two
 * rolling categories once a new UTC day starts, but never twice on the same
 * day. */
function utcDayKeyForDedup(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface NewOpportunityCandidate {
  id: string;
  mint: string;
  name: string | undefined;
  symbol: string | undefined;
  dex: string;
  liquidityUsd: number | undefined;
  marketCapUsd: number | undefined;
  aiScore: number | undefined;
  firstSeenAt: Date;
}

/** Real tokens detected since `deployedAt`, oldest-first, not yet posted —
 * the "🆕 New Opportunity" category: a brand-new candidate the scanner just
 * found, before any trade or trend signal exists for it. */
export async function fetchNewOpportunityCandidates(
  prisma: PrismaClient,
  limit: number,
  deployedAt: Date,
): Promise<NewOpportunityCandidate[]> {
  const candidates = await prisma.token.findMany({
    where: { firstSeenAt: { gte: deployedAt } },
    orderBy: { firstSeenAt: 'asc' },
    take: limit * 4,
  });
  const unposted = await filterUnposted(
    prisma,
    FEED_TYPES.NEW_OPPORTUNITY,
    candidates.map((t) => t.id),
  );
  return candidates
    .filter((t) => unposted.has(t.id))
    .slice(0, limit)
    .map((t) => ({
      id: t.id,
      mint: t.mint,
      name: t.name ?? undefined,
      symbol: t.symbol ?? undefined,
      dex: t.dex,
      liquidityUsd: t.liquidityUsd ?? undefined,
      marketCapUsd: t.marketCapUsd ?? undefined,
      aiScore: t.aiScore ?? undefined,
      firstSeenAt: t.firstSeenAt,
    }));
}

export interface MarketActivityCandidate {
  /** Already the day-bucketed dedup key (`${tokenId}:${dayKey}`) — pass
   * straight through to markActivityFeedPosted. */
  id: string;
  mint: string;
  name: string | undefined;
  symbol: string | undefined;
  dex: string;
  detectedAt: Date;
}

/** Rolling pool of bot-detected tokens (never ones the bot never touched —
 * see the "bot-detected tokens only" scope decision) eligible for a generic
 * "📊 Market Activity" post, used as filler content on a quiet day when no
 * bot trade has happened. Day-bucketed dedup lets the same token resurface
 * once a new UTC day starts, never twice within it. */
export async function fetchMarketActivityCandidates(
  prisma: PrismaClient,
  limit: number,
  deployedAt: Date,
  now: Date,
): Promise<MarketActivityCandidate[]> {
  const windowStart = new Date(
    Math.max(deployedAt.getTime(), now.getTime() - MARKET_ACTIVITY_LOOKBACK_HOURS * 60 * 60 * 1000),
  );
  const candidates = await prisma.token.findMany({
    where: { firstSeenAt: { gte: windowStart } },
    orderBy: { firstSeenAt: 'desc' },
    take: limit * 4,
  });
  const dayKey = utcDayKeyForDedup(now);
  const refIds = candidates.map((t) => `${t.id}:${dayKey}`);
  const unposted = await filterUnposted(prisma, FEED_TYPES.MARKET_ACTIVITY, refIds);
  return candidates
    .filter((t) => unposted.has(`${t.id}:${dayKey}`))
    .slice(0, limit)
    .map((t) => ({
      id: `${t.id}:${dayKey}`,
      mint: t.mint,
      name: t.name ?? undefined,
      symbol: t.symbol ?? undefined,
      dex: t.dex,
      detectedAt: t.firstSeenAt,
    }));
}

export interface TrendingTokenDbCandidate {
  /** Already the day-bucketed dedup key — see MarketActivityCandidate.id. */
  id: string;
  mint: string;
  name: string | undefined;
  symbol: string | undefined;
  dex: string;
  detectedAt: Date;
}

/** Rolling pool of bot-detected tokens eligible to be *checked* for a real,
 * live trending signal — this is the raw DB candidate list only; monitor.ts
 * still has to fetch each mint's current DexScreener stats and apply the
 * trending threshold before actually posting one (see its own doc comment).
 * A candidate that doesn't currently clear the bar is left unposted and
 * re-checked on a later tick, within the same day-bucket window. */
export async function fetchTrendingTokenDbCandidates(
  prisma: PrismaClient,
  limit: number,
  deployedAt: Date,
  now: Date,
): Promise<TrendingTokenDbCandidate[]> {
  const windowStart = new Date(
    Math.max(deployedAt.getTime(), now.getTime() - TRENDING_TOKEN_LOOKBACK_HOURS * 60 * 60 * 1000),
  );
  const candidates = await prisma.token.findMany({
    where: { firstSeenAt: { gte: windowStart } },
    orderBy: { firstSeenAt: 'desc' },
    take: limit * 4,
  });
  const dayKey = utcDayKeyForDedup(now);
  const refIds = candidates.map((t) => `${t.id}:${dayKey}`);
  const unposted = await filterUnposted(prisma, FEED_TYPES.TRENDING_TOKEN, refIds);
  return candidates
    .filter((t) => unposted.has(`${t.id}:${dayKey}`))
    .slice(0, limit)
    .map((t) => ({
      id: `${t.id}:${dayKey}`,
      mint: t.mint,
      name: t.name ?? undefined,
      symbol: t.symbol ?? undefined,
      dex: t.dex,
      detectedAt: t.firstSeenAt,
    }));
}

export interface WhaleAlertCandidate {
  id: string;
  walletAddress: string;
  mint: string;
  tokenName: string | undefined;
  tokenSymbol: string | undefined;
  confidenceScore: number;
  winRate: number | undefined;
  entryMarketCapUsd: number | undefined;
  entryAt: Date;
}

/** Real smart-wallet entries since `deployedAt`, restricted to wallets with
 * enough sample history to be confident about (see MIN_WHALE_CONFIDENCE) —
 * not yet posted. */
export async function fetchWhaleAlertCandidates(
  prisma: PrismaClient,
  limit: number,
  deployedAt: Date,
): Promise<WhaleAlertCandidate[]> {
  const candidates = await prisma.smartWalletTokenEntry.findMany({
    where: {
      entryAt: { gte: deployedAt },
      wallet: { confidenceScore: { gte: MIN_WHALE_CONFIDENCE } },
    },
    include: { wallet: true, token: true },
    orderBy: { entryAt: 'asc' },
    take: limit * 4,
  });
  const unposted = await filterUnposted(
    prisma,
    FEED_TYPES.WHALE_ALERT,
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
      entryMarketCapUsd: c.entryMarketCapUsd ?? undefined,
      entryAt: c.entryAt,
    }));
}

export interface SecurityAlertCandidate {
  id: string;
  mint: string;
  name: string | undefined;
  symbol: string | undefined;
  safetyScore: number;
  detectedAt: Date;
}

/** Real tokens that cleared the critical security gate (see
 * shadowModeEvaluator.ts's recordShadowDecision, called only for tokens that
 * already passed it) since `deployedAt`, not yet posted. */
export async function fetchSecurityAlertCandidates(
  prisma: PrismaClient,
  limit: number,
  deployedAt: Date,
): Promise<SecurityAlertCandidate[]> {
  const candidates = await prisma.shadowModeDecisionLog.findMany({
    where: { detectedAt: { gte: deployedAt } },
    include: { token: true },
    orderBy: { detectedAt: 'asc' },
    take: limit * 4,
  });
  const unposted = await filterUnposted(
    prisma,
    FEED_TYPES.SECURITY_ALERT,
    candidates.map((c) => c.id),
  );
  return candidates
    .filter((c) => unposted.has(c.id))
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      mint: c.mint,
      name: c.token.name ?? undefined,
      symbol: c.token.symbol ?? undefined,
      safetyScore: c.safetyScore,
      detectedAt: c.detectedAt,
    }));
}

/** Has a weekly summary already been posted for this ISO week-start date key? */
export async function isWeekAlreadySummarized(
  prisma: PrismaClient,
  weekStartKey: string,
): Promise<boolean> {
  const existing = await prisma.activityFeedPost.findUnique({
    where: { feedType_refId: { feedType: FEED_TYPES.WEEKLY_SUMMARY, refId: weekStartKey } },
  });
  return existing !== null;
}
