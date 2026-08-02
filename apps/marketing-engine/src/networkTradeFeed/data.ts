import type { PrismaClient } from '@prisma/client';

/**
 * Network Trade Feed (2026-08-02) — a curated feed of *other* real wallets'
 * completed trades (not this bot's own — see tradeShowcase for that),
 * sourced from SmartWalletTokenEntry rows that smartWalletTracker.ts's
 * checkAndRecordExit has resolved to a real, on-chain-verified full exit
 * (status EXITED, real entryAmountSol/exitAmountSol/realizedPnlUsd — never a
 * price-based estimate). Scoped to whatever smart-wallet detection actually
 * covers today (pre-migration pump.fun — see smartWalletTracker.ts's own doc
 * comment); this module makes no claim to cover PumpSwap/Raydium/Orca/
 * Meteora/Jupiter until real detection exists for them.
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
