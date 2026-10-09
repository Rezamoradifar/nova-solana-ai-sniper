import type { PrismaClient } from '@prisma/client';

export const COPY_RECOMMENDATION_POLICY = {
  lookbackDays: 30,
  minClosedTrades: 20,
  minDistinctTokens: 5,
  minProfitFactor: 1.5,
  minWinRatePct: 50,
  minMedianHoldSeconds: 120,
  maxWinnerConcentrationPct: 50,
  maxRugExposurePct: 5,
  maxSybilConfidencePct: 20,
  maxInactiveHours: 72,
} as const;

interface Observation {
  mint: string;
  entryAt: Date;
  exitAt: Date | null;
  exitSignature: string | null;
  status: string;
  realizedPnlSol: number | null;
  isRugOrScam: boolean;
}

/** Ranks the recorded sample, never fabricates a wallet's complete portfolio. */
export function rankCopyWallet(
  entries: Observation[],
  sybilConfidencePct: number | null,
  now = Date.now(),
) {
  const p = COPY_RECOMMENDATION_POLICY;
  const recent = entries.filter(
    (e) => e.entryAt.getTime() >= now - p.lookbackDays * 86_400_000 && e.entryAt.getTime() <= now,
  );
  const verified = recent.filter(
    (e) =>
      e.status === 'EXITED' &&
      e.exitSignature &&
      e.exitAt &&
      e.exitAt.getTime() >= e.entryAt.getTime() &&
      e.exitAt.getTime() <= now &&
      e.realizedPnlSol !== null &&
      Number.isFinite(e.realizedPnlSol),
  );
  // The observation ledger does not aggregate multiple buys into a full cost basis.
  // Exclude reused exit signatures instead of counting the same sale repeatedly.
  const exits = new Map<string, number>();
  for (const e of verified) exits.set(e.exitSignature!, (exits.get(e.exitSignature!) ?? 0) + 1);
  const closed = verified.filter((e) => exits.get(e.exitSignature!) === 1);
  const gains = closed.reduce((sum, e) => sum + Math.max(0, e.realizedPnlSol!), 0);
  const losses = closed.reduce((sum, e) => sum + Math.max(0, -e.realizedPnlSol!), 0);
  const realizedPnlSol = gains - losses;
  const profitFactor = losses > 0 ? gains / losses : null;
  const winRatePct = closed.length
    ? (closed.filter((e) => e.realizedPnlSol! > 0).length / closed.length) * 100
    : 0;
  const holds = closed
    .map((e) => (e.exitAt!.getTime() - e.entryAt.getTime()) / 1000)
    .sort((a, b) => a - b);
  const mid = Math.floor(holds.length / 2);
  const medianHoldSeconds = holds.length
    ? holds.length % 2
      ? holds[mid]!
      : (holds[mid - 1]! + holds[mid]!) / 2
    : 0;
  const winnerConcentrationPct =
    gains > 0 ? (Math.max(...closed.map((e) => e.realizedPnlSol!)) / gains) * 100 : 100;
  const rugExposurePct = recent.length
    ? (recent.filter((e) => e.isRugOrScam).length / recent.length) * 100
    : 0;
  const distinctTokens = new Set(closed.map((e) => e.mint)).size;
  const lastExitMs = closed.length ? Math.max(...closed.map((e) => e.exitAt!.getTime())) : 0;
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (closed.length < p.minClosedTrades) reasons.push('Fewer than 20 verified closed trades');
  if (distinctTokens < p.minDistinctTokens) reasons.push('Fewer than 5 distinct tokens');
  if (realizedPnlSol <= 0) reasons.push('Recorded realized SOL profit is not positive');
  if (profitFactor !== null && profitFactor < p.minProfitFactor)
    reasons.push('Profit factor below 1.5');
  if (winRatePct < p.minWinRatePct) reasons.push('Win rate below 50%');
  if (medianHoldSeconds < p.minMedianHoldSeconds)
    reasons.push('Trades too short for delayed copying');
  if (winnerConcentrationPct > p.maxWinnerConcentrationPct)
    reasons.push('Profit depends on one outlier');
  if (rugExposurePct > p.maxRugExposurePct) reasons.push('Rug exposure above 5%');
  if (sybilConfidencePct === null || !Number.isFinite(sybilConfidencePct))
    warnings.push('Sybil assessment unavailable; review wallet before enabling');
  else if (sybilConfidencePct > p.maxSybilConfidencePct) reasons.push('Elevated Sybil risk');
  if (now - lastExitMs > p.maxInactiveHours * 3_600_000)
    reasons.push('No verified exit within 72 hours');
  const score = Math.max(
    0,
    Math.round(
      Math.min(closed.length / 50, 1) * 20 +
        Math.min(distinctTokens / 10, 1) * 15 +
        (Math.min(profitFactor ?? (gains > 0 ? 3 : 0), 3) / 3) * 25 +
        winRatePct * 0.25 +
        (100 - winnerConcentrationPct) * 0.15 -
        rugExposurePct,
    ),
  );
  return {
    eligible: reasons.length === 0,
    warnings,
    reasons,
    score,
    closedTrades: closed.length,
    distinctTokens,
    realizedPnlSol,
    profitFactor,
    winRatePct,
    medianHoldSeconds,
    winnerConcentrationPct,
    rugExposurePct,
  };
}

export async function loadRankedCopyWallets(prisma: PrismaClient, now = Date.now()) {
  const wallets = await prisma.smartWallet.findMany({
    where: {
      isTracked: true,
      entries: { some: { entryAt: { gte: new Date(now - 30 * 86_400_000) } } },
    },
    orderBy: [{ entries: { _count: 'desc' } }, { address: 'asc' }],
    take: 100,
    select: {
      address: true,
      label: true,
      confidenceScore: true,
      sampleSize: true,
      medianRoiPercent: true,
      avgRoiPercent: true,
      earlyEntryRatePct: true,
      rugExposureRatePct: true,
      realizedPnlUsd: true,
      unrealizedPnlUsd: true,
      lastActivityAt: true,
      sybilConfidencePct: true,
      entries: {
        where: { entryAt: { gte: new Date(now - 30 * 86_400_000) } },
        orderBy: { entryAt: 'desc' },
        take: 501,
        select: {
          mint: true,
          entryAt: true,
          exitAt: true,
          exitSignature: true,
          status: true,
          realizedPnlSol: true,
          isRugOrScam: true,
        },
      },
    },
  });
  const internal = await prisma.wallet.findMany({
    where: { publicKey: { in: wallets.map((w) => w.address) } },
    select: { publicKey: true },
  });
  const internalAddresses = new Set(internal.map((w) => w.publicKey));
  return wallets
    .filter((w) => !internalAddresses.has(w.address))
    .map(({ entries, ...wallet }) => {
      const recommendation = rankCopyWallet(entries, wallet.sybilConfidencePct, now);
      if (entries.length > 500) {
        recommendation.eligible = false;
        recommendation.reasons.push('History exceeds the bounded review sample');
      }
      return { ...wallet, signalScore: recommendation.score, recommendation };
    })
    .sort(
      (a, b) =>
        Number(b.recommendation.eligible) - Number(a.recommendation.eligible) ||
        b.recommendation.score - a.recommendation.score ||
        a.address.localeCompare(b.address),
    );
}
