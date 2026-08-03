import type { PrismaClient } from '@prisma/client';

/**
 * Network Trade Feed (2026-08-02) — a curated feed of *other* real wallets'
 * completed trades (not this bot's own — see tradeShowcase for that),
 * sourced from SmartWalletTokenEntry rows that smartWalletTracker.ts's
 * checkAndRecordExit has resolved to a real, on-chain-verified full exit
 * (status EXITED, real entryAmountSol/exitAmountSol/realizedPnlUsd — never a
 * price-based estimate). Coverage is DEX-agnostic: extractBuyerFromTransaction/
 * extractSellFromTransaction key off balance deltas, not a pump.fun-specific
 * instruction, and apps/api's NetworkTradeScannerService (2026-08-02) feeds
 * evaluateForToken a rotating slice of recently-active tokens across every
 * DEX the bot has ever discovered (Token.dex), not just the live pre-migration
 * pump.fun candidate pipeline — see networkTradeScanner.ts's own doc comment.
 *
 * Same table/dedup-join pattern as activityFeed/data.ts and
 * ecosystemFeed/data.ts (own copy, not a cross-import — see those modules'
 * own doc comments for why), but permanent rather than day-bucketed: a
 * completed trade is a one-time historical fact, never re-checked or
 * re-posted on a later day the way a still-open candidate might be.
 */

export const NETWORK_TRADE_FEED_TYPE = 'NETWORK_TRADE';

export interface NetworkTradeCandidate {
  entryId: string;
  mint: string;
  tokenName: string | undefined;
  tokenSymbol: string | undefined;
  dex: string;
  aiScore: number | undefined;
  walletAddress: string;
  walletConfidenceScore: number | undefined;
  entryAt: Date;
  exitAt: Date;
  entrySignature: string;
  exitSignature: string;
  entryPriceUsd: number | undefined;
  exitPriceUsd: number | undefined;
  entryAmountSol: number;
  exitAmountSol: number;
  realizedRoiPercent: number;
  realizedPnlSol: number;
  realizedPnlUsd: number;
}

async function filterUnposted(prisma: PrismaClient, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const posted = await prisma.activityFeedPost.findMany({
    where: { feedType: NETWORK_TRADE_FEED_TYPE, refId: { in: ids } },
    select: { refId: true },
  });
  const postedIds = new Set(posted.map((p) => p.refId));
  return new Set(ids.filter((id) => !postedIds.has(id)));
}

export async function markNetworkTradePosted(prisma: PrismaClient, entryId: string): Promise<void> {
  await prisma.activityFeedPost.create({
    data: { feedType: NETWORK_TRADE_FEED_TYPE, refId: entryId },
  });
}

/**
 * Real, fully-resolved completed exits only — every filter below exists to
 * exclude an entry checkAndRecordExit couldn't fully resolve (entryAmountSol
 * captured before that field existed, or a sell whose SOL amount couldn't be
 * read) rather than posting a partial/estimated trade.
 */
export async function fetchNetworkTradeCandidates(
  prisma: PrismaClient,
  limit: number,
  deployedAt: Date,
): Promise<NetworkTradeCandidate[]> {
  const rows = await prisma.smartWalletTokenEntry.findMany({
    where: {
      status: 'EXITED',
      exitAt: { gte: deployedAt },
      entryAmountSol: { not: null },
      exitAmountSol: { not: null },
      realizedPnlUsd: { not: null },
      realizedRoiPercent: { not: null },
    },
    orderBy: { exitAt: 'desc' },
    take: limit,
    include: { token: true, wallet: true },
  });

  const unposted = await filterUnposted(
    prisma,
    rows.map((r) => r.id),
  );

  return rows
    .filter((r) => unposted.has(r.id))
    .map((r) => ({
      entryId: r.id,
      mint: r.mint,
      tokenName: r.token?.name ?? undefined,
      tokenSymbol: r.token?.symbol ?? undefined,
      dex: r.token?.dex ?? 'PUMPFUN',
      aiScore: r.token?.aiScore ?? undefined,
      walletAddress: r.walletAddress,
      walletConfidenceScore: r.wallet.confidenceScore ?? undefined,
      entryAt: r.entryAt,
      exitAt: r.exitAt!,
      entrySignature: r.entrySignature,
      exitSignature: r.exitSignature!,
      entryPriceUsd: r.entryPriceUsd ?? undefined,
      exitPriceUsd: r.exitPriceUsd ?? undefined,
      entryAmountSol: r.entryAmountSol!,
      exitAmountSol: r.exitAmountSol!,
      realizedRoiPercent: r.realizedRoiPercent!,
      realizedPnlSol: r.realizedPnlSol ?? r.exitAmountSol! - r.entryAmountSol!,
      realizedPnlUsd: r.realizedPnlUsd!,
    }));
}

export type NetworkTradeCategory =
  'SMART_MONEY' | 'TRENDING_TOKEN' | 'NETWORK_PROFIT' | 'NETWORK_LOSS';

/** Same confidence bar as activityFeed/data.ts's WhaleAlertCandidate
 * (MIN_WHALE_CONFIDENCE) — a wallet is never called out as "smart money"
 * off a single lucky trade, only once its track record has enough resolved
 * samples to be confident about (see MIN_SAMPLE_SIZE_FOR_CONFIDENCE in
 * smartWalletTracker.ts, upstream of confidenceScore existing at all). */
const SMART_MONEY_MIN_CONFIDENCE = 50;

/** Same volume normalization constant scoreNetworkTradeCandidate already
 * uses for its own trending proxy — a token doing six figures of real 24h
 * volume is trending regardless of who's trading it. */
const TRENDING_MIN_VOLUME_USD = 100_000;

/** A real double-digit hourly move is the other, faster trending signal
 * (volume can lag a spike briefly; price never does). */
const TRENDING_MIN_H1_CHANGE_PERCENT = 20;

export interface NetworkTradeCategoryInputs {
  realizedPnlUsd: number;
  walletConfidenceScore: number | undefined;
  volume24hUsd: number | undefined;
  priceChangeH1Percent: number | undefined;
}

/**
 * Which of the spec's four categories (NETWORK PROFIT / NETWORK LOSS /
 * SMART MONEY / TRENDING TOKEN) badges this post. Most-specific-signal-first:
 * a wallet with a real track record is the most notable thing about a trade,
 * then a token currently trending independent of who traded it, and only
 * then does it fall back to a plain win/loss. The 🟢/🔴 profit-or-loss
 * coloring in the caption header is independent of this and always shown —
 * see buildNetworkTradeCaptionHtml — so a SMART_MONEY or TRENDING_TOKEN post
 * never hides whether it was actually a win or a loss.
 */
export function categorizeNetworkTrade(inputs: NetworkTradeCategoryInputs): NetworkTradeCategory {
  if ((inputs.walletConfidenceScore ?? 0) >= SMART_MONEY_MIN_CONFIDENCE) return 'SMART_MONEY';
  if (
    (inputs.volume24hUsd ?? 0) >= TRENDING_MIN_VOLUME_USD ||
    Math.abs(inputs.priceChangeH1Percent ?? 0) >= TRENDING_MIN_H1_CHANGE_PERCENT
  ) {
    return 'TRENDING_TOKEN';
  }
  return inputs.realizedPnlUsd >= 0 ? 'NETWORK_PROFIT' : 'NETWORK_LOSS';
}

export interface NetworkTradeScoreInputs {
  realizedRoiPercent: number;
  realizedPnlUsd: number;
  walletConfidenceScore: number | undefined;
  entryAmountSol: number;
  volume24hUsd: number | undefined;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Pure, independently unit-tested composite score (0-100) — the "select only
 * the best trades" gate. Uses absolute ROI/PnL (not signed) so a large,
 * notable LOSS scores just as high as an equally large win: this feed is
 * meant to mix profitable and losing trades naturally, not filter losses out
 * as "bad content." Weights: ROI 30, PnL magnitude 25, wallet track record
 * 20, position size (a whale-activity proxy — no separate trade-size-based
 * signal exists) 15, live 24h volume (a trending proxy) 10.
 */
export function scoreNetworkTradeCandidate(inputs: NetworkTradeScoreInputs): number {
  const roiScore = clamp01(Math.abs(inputs.realizedRoiPercent) / 500) * 30;
  const pnlScore = clamp01(Math.abs(inputs.realizedPnlUsd) / 5000) * 25;
  const walletScore = clamp01((inputs.walletConfidenceScore ?? 0) / 100) * 20;
  const whaleScore = clamp01(inputs.entryAmountSol / 10) * 15;
  const volumeScore = clamp01((inputs.volume24hUsd ?? 0) / 100_000) * 10;
  return roiScore + pnlScore + walletScore + whaleScore + volumeScore;
}

/**
 * Daily post-mix quota (2026-08-03, project spec) — a real completed trade
 * only qualifies for this feed at all if its ROI lands in one of these three
 * bands; anything else (a small loss better than -20%, or a loss worse than
 * -25%) is simply never eligible, same "never fabricate/substitute to fill a
 * quota" convention as everywhere else in this module. HIGH_PROFIT/
 * SMALL_PROFIT split at +50% ROI; LOSS_BAND is intentionally narrow
 * (-25%..-20% inclusive) per spec, not "any loss."
 */
export type NetworkTradePostBucket = 'HIGH_PROFIT' | 'SMALL_PROFIT' | 'LOSS_BAND';

const HIGH_PROFIT_ROI_THRESHOLD = 50;
const LOSS_BAND_MIN_ROI = -25;
const LOSS_BAND_MAX_ROI = -20;

/** Each bucket's own daily ceiling — never a floor, per this module's
 * standing convention. Caps sum to the spec's 30 posts/day total. */
export const NETWORK_TRADE_DAILY_BUCKET_CAPS: Record<NetworkTradePostBucket, number> = {
  HIGH_PROFIT: 20,
  SMALL_PROFIT: 5,
  LOSS_BAND: 5,
};

export function classifyNetworkTradePostBucket(
  realizedRoiPercent: number,
): NetworkTradePostBucket | undefined {
  if (realizedRoiPercent >= HIGH_PROFIT_ROI_THRESHOLD) return 'HIGH_PROFIT';
  if (realizedRoiPercent >= 0) return 'SMALL_PROFIT';
  if (realizedRoiPercent >= LOSS_BAND_MIN_ROI && realizedRoiPercent <= LOSS_BAND_MAX_ROI) {
    return 'LOSS_BAND';
  }
  return undefined;
}
