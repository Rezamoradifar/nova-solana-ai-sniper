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
  /// Wallet's historical rate of trading tokens that turned out to be rugs
  /// (see SmartWallet.rugExposureRatePct) — a quality signal on the WALLET's
  /// track record, independent of whether this specific trade was profitable.
  walletRugExposureRatePct: number | undefined;
  /// 0-100 confidence this wallet is part of a manipulated/Sybil cluster (see
  /// SmartWallet.sybilConfidencePct / sybilDetector.ts) — the spam/wash-
  /// trading signal used to keep bot-farm wallets out of this feed.
  walletSybilConfidencePct: number | undefined;
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
      walletRugExposureRatePct: r.wallet.rugExposureRatePct ?? undefined,
      walletSybilConfidencePct: r.wallet.sybilConfidencePct ?? undefined,
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
  'TRENDING_TOKEN' | 'SMART_MONEY' | 'WHALE_WALLET' | 'NETWORK_PROFIT' | 'NETWORK_LOSS';

/** Same confidence bar as activityFeed/data.ts's WhaleAlertCandidate
 * (MIN_WHALE_CONFIDENCE) — a wallet is never called out as "smart money"
 * off a single lucky trade, only once its track record has enough resolved
 * samples to be confident about (see MIN_SAMPLE_SIZE_FOR_CONFIDENCE in
 * smartWalletTracker.ts, upstream of confidenceScore existing at all). */
const SMART_MONEY_MIN_CONFIDENCE = 50;

/** A token doing six figures of real 24h volume is trending regardless of
 * who's trading it. */
const TRENDING_MIN_VOLUME_USD = 100_000;

/** A real double-digit hourly move is the other, faster trending signal
 * (volume can lag a spike briefly; price never does). */
const TRENDING_MIN_H1_CHANGE_PERCENT = 20;

/** A single real entry this large is a whale-sized bet regardless of who's
 * making it — the "Whale Wallets" tier (priority 3, 2026-08-05 spec). */
const WHALE_MIN_ENTRY_SOL = 5;

export interface NetworkTradeCategoryInputs {
  realizedPnlUsd: number;
  walletConfidenceScore: number | undefined;
  volume24hUsd: number | undefined;
  priceChangeH1Percent: number | undefined;
  entryAmountSol: number;
}

/**
 * Which of the spec's five categories badges this post. Same precedence
 * order as this module's own selection priority (see
 * computeNetworkTradePriorityTier below) — Trending Tokens > Smart Money >
 * Whale Wallets > plain win/loss — so the badge always matches the reason a
 * candidate was actually picked over the others. The 🟢/🔴 profit-or-loss
 * coloring in the caption header is independent of this and always shown —
 * see buildNetworkTradeCaptionHtml — so no badge ever hides whether a trade
 * was actually a win or a loss.
 */
export function categorizeNetworkTrade(inputs: NetworkTradeCategoryInputs): NetworkTradeCategory {
  if (
    (inputs.volume24hUsd ?? 0) >= TRENDING_MIN_VOLUME_USD ||
    Math.abs(inputs.priceChangeH1Percent ?? 0) >= TRENDING_MIN_H1_CHANGE_PERCENT
  ) {
    return 'TRENDING_TOKEN';
  }
  if ((inputs.walletConfidenceScore ?? 0) >= SMART_MONEY_MIN_CONFIDENCE) return 'SMART_MONEY';
  if (inputs.entryAmountSol >= WHALE_MIN_ENTRY_SOL) return 'WHALE_WALLET';
  return inputs.realizedPnlUsd >= 0 ? 'NETWORK_PROFIT' : 'NETWORK_LOSS';
}

/**
 * Real losses read as natural, honest content ("not every trade wins") —
 * only a loss steep enough to look like a rug gets excluded outright, never
 * any loss at all (2026-08-05 spec: "prefer profitable trades, small losses
 * are acceptable"). -30% is the cutoff: worse than that reads as a rug/
 * dump, not a normal losing trade.
 */
const MIN_ACCEPTABLE_ROI_PERCENT = -30;

/** A wallet whose own historical trades have rugged this often is a spam/
 * low-quality signal on the WALLET, independent of whether this specific
 * trade happened to be profitable (SmartWallet.rugExposureRatePct). */
const MAX_ACCEPTABLE_RUG_EXPOSURE_PCT = 50;

/** Wallets sybilDetector.ts has flagged as probably part of a manipulated /
 * wash-trading cluster are the "spam" this feed must never showcase as real
 * organic activity (SmartWallet.sybilConfidencePct). */
const MAX_ACCEPTABLE_SYBIL_CONFIDENCE_PCT = 70;

export interface NetworkTradeQualityInputs {
  realizedRoiPercent: number;
  walletRugExposureRatePct: number | undefined;
  walletSybilConfidencePct: number | undefined;
}

/**
 * The "skip spam, rugs and duplicate wallets" quality gate (2026-08-05 spec)
 * — the duplicate-wallet cooldown itself lives in monitor.ts instead, since
 * it needs recent-post history rather than a property of the candidate
 * alone. A real loss is never excluded just for being a loss; only a loss
 * steep enough to look like a rug, or a wallet with its own bad track
 * record, reads as noise rather than a legitimate completed trade.
 */
export function isNetworkTradeCandidateEligible(inputs: NetworkTradeQualityInputs): boolean {
  if (inputs.realizedRoiPercent < MIN_ACCEPTABLE_ROI_PERCENT) return false;
  if ((inputs.walletRugExposureRatePct ?? 0) > MAX_ACCEPTABLE_RUG_EXPOSURE_PCT) return false;
  if ((inputs.walletSybilConfidencePct ?? 0) > MAX_ACCEPTABLE_SYBIL_CONFIDENCE_PCT) return false;
  return true;
}

export interface NetworkTradePriorityInputs {
  realizedRoiPercent: number;
  realizedPnlUsd: number;
  walletConfidenceScore: number | undefined;
  entryAmountSol: number;
  volume24hUsd: number | undefined;
  priceChangeH1Percent: number | undefined;
}

/** 1 = Trending Tokens, 2 = Smart Money, 3 = Whale Wallets, 4 = neither —
 * ranked against every other tier-4 candidate purely by ROI then PnL (see
 * compareNetworkTradeCandidatesByPriority). Lower number = higher priority. */
export type NetworkTradePriorityTier = 1 | 2 | 3 | 4;

/**
 * Selection priority order (2026-08-05 project spec): Trending Tokens >
 * Smart Money > Whale Wallets > Highest ROI > Highest PnL. The first three
 * are genuine categories — the most notable real signal about a trade wins
 * outright, same precedence as categorizeNetworkTrade's badge. ROI and PnL
 * aren't separate categories: every candidate that clears none of the first
 * three signals shares tier 4, where compareNetworkTradeCandidatesByPriority
 * ranks them by ROI first and PnL second — that's what makes "Highest ROI"
 * and "Highest PnL" priorities 4 and 5 rather than tiers of their own.
 */
export function computeNetworkTradePriorityTier(
  inputs: NetworkTradePriorityInputs,
): NetworkTradePriorityTier {
  if (
    (inputs.volume24hUsd ?? 0) >= TRENDING_MIN_VOLUME_USD ||
    Math.abs(inputs.priceChangeH1Percent ?? 0) >= TRENDING_MIN_H1_CHANGE_PERCENT
  ) {
    return 1;
  }
  if ((inputs.walletConfidenceScore ?? 0) >= SMART_MONEY_MIN_CONFIDENCE) return 2;
  if (inputs.entryAmountSol >= WHALE_MIN_ENTRY_SOL) return 3;
  return 4;
}

/**
 * Full priority-order comparator — sorting a candidate list with this and
 * taking index 0 picks the single best candidate per the spec's 5-level
 * priority list in one pass. Category tier ascending first (tier 1 wins
 * outright over tier 4 regardless of ROI/PnL), then Highest ROI, then
 * Highest PnL as the final tie-break.
 */
export function compareNetworkTradeCandidatesByPriority(
  a: NetworkTradePriorityInputs,
  b: NetworkTradePriorityInputs,
): number {
  const tierDiff = computeNetworkTradePriorityTier(a) - computeNetworkTradePriorityTier(b);
  if (tierDiff !== 0) return tierDiff;
  if (b.realizedRoiPercent !== a.realizedRoiPercent) {
    return b.realizedRoiPercent - a.realizedRoiPercent;
  }
  return b.realizedPnlUsd - a.realizedPnlUsd;
}
