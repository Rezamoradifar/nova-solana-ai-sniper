import type {
  Connection,
  ParsedTransactionWithMeta,
  PublicKey as PublicKeyType,
} from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { PrismaClient, SmartWallet, SmartWalletEntryStatus } from '@prisma/client';
import type { Logger } from '@nova/shared';

/**
 * Smart Money Analysis (Sections 3-4, 2026-07-22). Pure decision functions
 * live here (same convention as criticalSecurityGate.ts/sellabilityCheck.ts/
 * consensus.ts) so wallet-confidence math and cluster-buy detection are
 * independently unit-tested without RPC/DB fixtures. `SmartWalletTrackerService`
 * (bottom of file) is the thin I/O orchestration layer.
 *
 * Scoped to pre-migration pump.fun tokens for v1 (see resolveRecentBuyEvents):
 * buyer wallets are resolved from the mint account's own recent signature
 * history (`getSignaturesForAddress`), bounded to a small, fixed number of
 * signatures per token that already passed the critical security gate — never
 * a network-wide subscription to all pump.fun/DEX traffic. Post-migration
 * swap-log parsing is a documented future extension, not built here.
 */

/** A wallet is never scored confident off a single successful trade — this is
 * the minimum count of *resolved* (win/loss known) entries before
 * computeWalletConfidence returns a real number instead of `undefined`. */
export const MIN_SAMPLE_SIZE_FOR_CONFIDENCE = 5;

/** An entry within this many seconds of pool creation counts toward
 * earlyEntryRatePct — 10 minutes, generous enough to include a slightly
 * delayed first read but well inside "was actually early," not a late chase. */
export const EARLY_ENTRY_WINDOW_SECONDS = 10 * 60;

/** Exponential recency decay half-life for weighting a wallet's most recent
 * activity — a wallet whose only good trades are 3 months stale is trusted
 * less than one with a similar record active this week. */
export const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

export interface WalletEntrySummary {
  entryAt: Date;
  secondsAfterPoolCreation?: number;
  status: SmartWalletEntryStatus;
  realizedRoiPercent?: number;
  unrealizedRoiPercent?: number;
  isRugOrScam: boolean;
}

export interface WalletConfidenceResult {
  /** 0-100. undefined below MIN_SAMPLE_SIZE_FOR_CONFIDENCE resolved entries. */
  confidenceScore?: number;
  sampleSize: number;
  medianRoiPercent?: number;
  avgRoiPercent?: number;
  earlyEntryRatePct?: number;
  rugExposureRatePct?: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * "Resolved" means the outcome is actually known: EXITED (a real
 * realizedRoiPercent) or EXPIRED/RUG_FLAGGED (unrealizedRoiPercent used as the
 * best-available proxy — see shadowModePriceSampler.ts, which marks entries
 * EXPIRED after its evaluation window closes). OPEN entries are still
 * pending and deliberately excluded from sampleSize — an outcome nobody knows
 * yet must never count toward a wallet's track record either way.
 */
export function computeWalletConfidence(
  entries: WalletEntrySummary[],
  now: number,
): WalletConfidenceResult {
  const resolved = entries.filter((e) => e.status !== 'OPEN');
  const sampleSize = resolved.length;
  if (sampleSize < MIN_SAMPLE_SIZE_FOR_CONFIDENCE) {
    return { confidenceScore: undefined, sampleSize };
  }

  const rois = resolved.map((e) => e.realizedRoiPercent ?? e.unrealizedRoiPercent ?? 0);
  const avgRoiPercent = rois.reduce((a, b) => a + b, 0) / rois.length;
  const medianRoiPercent = median(rois);
  const winCount = rois.filter((r) => r > 0).length;
  const winRatePct = (winCount / sampleSize) * 100;
  const earlyCount = resolved.filter(
    (e) => (e.secondsAfterPoolCreation ?? Infinity) <= EARLY_ENTRY_WINDOW_SECONDS,
  ).length;
  const earlyEntryRatePct = (earlyCount / sampleSize) * 100;
  const rugCount = resolved.filter((e) => e.isRugOrScam).length;
  const rugExposureRatePct = (rugCount / sampleSize) * 100;

  const mostRecentAgeMs = now - Math.max(...resolved.map((e) => e.entryAt.getTime()));
  const recencyFactor = Math.pow(0.5, Math.max(0, mostRecentAgeMs) / RECENCY_HALF_LIFE_MS);

  let base =
    winRatePct * 0.5 +
    Math.max(0, Math.min(medianRoiPercent, 200)) * 0.15 +
    earlyEntryRatePct * 0.2;
  base -= rugExposureRatePct * 0.8;
  base = Math.max(0, Math.min(100, base));

  // Recency never fully zeroes a strong historical record out — it dampens
  // between 50% and 100% of the base score, not down to 0, since a wallet
  // that was genuinely skilled doesn't become worthless the day after its
  // last trade.
  const confidenceScore = Math.round(base * (0.5 + 0.5 * recencyFactor));

  return {
    confidenceScore,
    sampleSize,
    medianRoiPercent,
    avgRoiPercent,
    earlyEntryRatePct,
    rugExposureRatePct,
  };
}

export interface WalletBuyEvent {
  walletAddress: string;
  /** Already discounted by applySybilDiscount if that was applied upstream. */
  confidenceScore?: number;
  sybilClusterId?: string;
  timestampMs: number;
}

/** Independently-high-confidence wallets buying the same token within a short
 * window — a real cluster-buy signal, not a coincidence. */
export const CLUSTER_BUY_WINDOW_MS = 5 * 60 * 1000;
export const MIN_INDEPENDENT_WALLETS_FOR_CLUSTER = 2;
export const MIN_CONFIDENCE_FOR_CLUSTER = 60;

export interface ClusterBuyResult {
  isClusterBuy: boolean;
  /** Count of distinct clusters (a Sybil cluster of 5 wallets counts as 1),
   * not distinct wallets — this is what "independently" enforces. */
  independentClusterCount: number;
  clusterKeys: string[];
}

/**
 * Groups by sybilClusterId (falling back to the wallet address itself when no
 * cluster was resolved) so wallets sharing a funding source never inflate the
 * "independent wallets" count — see sybilDetector.ts. Slides a window over
 * every buy's timestamp and keeps the widest set of distinct clusters found
 * within any windowMs span.
 */
export function detectClusterBuy(
  buys: WalletBuyEvent[],
  windowMs = CLUSTER_BUY_WINDOW_MS,
  minIndependentWallets = MIN_INDEPENDENT_WALLETS_FOR_CLUSTER,
  minConfidence = MIN_CONFIDENCE_FOR_CLUSTER,
): ClusterBuyResult {
  const qualifying = buys.filter((b) => (b.confidenceScore ?? 0) >= minConfidence);
  if (qualifying.length === 0) {
    return { isClusterBuy: false, independentClusterCount: 0, clusterKeys: [] };
  }

  const sorted = [...qualifying].sort((a, b) => a.timestampMs - b.timestampMs);
  let best = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const windowStart = sorted[i]!.timestampMs;
    const clusters = new Set<string>();
    for (let j = i; j < sorted.length && sorted[j]!.timestampMs - windowStart <= windowMs; j++) {
      clusters.add(sorted[j]!.sybilClusterId ?? sorted[j]!.walletAddress);
    }
    if (clusters.size > best.size) best = clusters;
  }

  return {
    isClusterBuy: best.size >= minIndependentWallets,
    independentClusterCount: best.size,
    clusterKeys: [...best],
  };
}

/** 0-100. Dominated by the strongest single wallet's confidence, with a
 * smaller average-confidence contribution and a bonus for a genuine
 * independent cluster buy (capped so a huge cluster can't alone reach 100). */
export function computeSmartMoneyScore(
  buys: WalletBuyEvent[],
  clusterResult: ClusterBuyResult,
): number {
  if (buys.length === 0) return 0;
  const confidences = buys.map((b) => b.confidenceScore ?? 0);
  const maxConfidence = Math.max(...confidences);
  const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  let score = maxConfidence * 0.6 + avgConfidence * 0.2;
  if (clusterResult.isClusterBuy) {
    score += Math.min(20, clusterResult.independentClusterCount * 7);
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Multiplicative discount (never a hard exclusion) so a wallet's legitimate
 * track record is preserved for sampleSize/history purposes even while its
 * contribution to SmartMoneyScore/cluster-buy counting is suppressed. Applied
 * once per evaluation, upstream of detectClusterBuy/computeSmartMoneyScore.
 */
export function applySybilDiscount(
  buys: WalletBuyEvent[],
  sybilConfidencePctByWallet: Map<string, number>,
): WalletBuyEvent[] {
  return buys.map((b) => {
    const sybilPct = sybilConfidencePctByWallet.get(b.walletAddress) ?? 0;
    if (sybilPct <= 0 || b.confidenceScore === undefined) return b;
    return { ...b, confidenceScore: b.confidenceScore * (1 - sybilPct / 100) };
  });
}

// --- I/O orchestration -----------------------------------------------------

export interface ExtractedBuyEvent {
  walletAddress: string;
  amountTokenUi: number;
}

/**
 * Fee payer of a parsed transaction — same cheapest-available-signal
 * convention as worker.ts's resolveDeployerAddress (documented limitation,
 * not a guarantee: a relayed/sponsored transaction could in principle have a
 * different fee payer than the real buyer). A "buy" is confirmed by the fee
 * payer's own token balance for this mint increasing between pre/post state
 * — costs zero extra RPC calls since the parsed tx is already fetched.
 */
export function extractBuyerFromTransaction(
  tx: ParsedTransactionWithMeta,
  mint: string,
): ExtractedBuyEvent | undefined {
  const feePayer = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58();
  if (!feePayer) return undefined;

  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  const postAmt = post
    .filter((b) => b.mint === mint && b.owner === feePayer)
    .reduce((sum, b) => sum + (b.uiTokenAmount.uiAmount ?? 0), 0);
  if (postAmt === 0) return undefined;

  const preAmt = pre
    .filter((b) => b.mint === mint && b.owner === feePayer)
    .reduce((sum, b) => sum + (b.uiTokenAmount.uiAmount ?? 0), 0);

  const delta = postAmt - preAmt;
  if (delta <= 0) return undefined;

  return { walletAddress: feePayer, amountTokenUi: delta };
}

export interface ResolvedBuyEvent extends ExtractedBuyEvent {
  signature: string;
  timestampMs: number;
}

export interface SmartMoneyEvaluation {
  smartMoneyScore?: number;
  clusterBuy: ClusterBuyResult;
  buyEvents: ResolvedBuyEvent[];
  sybilDiscountApplied: boolean;
}

const EMPTY_EVALUATION: SmartMoneyEvaluation = {
  smartMoneyScore: undefined,
  clusterBuy: { isClusterBuy: false, independentClusterCount: 0, clusterKeys: [] },
  buyEvents: [],
  sybilDiscountApplied: false,
};

/** Bounded per-token lookback — never a network-wide subscription. */
export const RECENT_BUY_LOOKBACK_LIMIT = 15;

export interface SmartWalletTrackerDeps {
  prisma: PrismaClient;
  connection: Connection;
  logger: Logger;
}

export class SmartWalletTrackerService {
  constructor(private readonly deps: SmartWalletTrackerDeps) {}

  /**
   * Resolves up to RECENT_BUY_LOOKBACK_LIMIT recent buy events for a mint
   * from its own signature history — bounded, one-shot, never a subscription.
   * Fails open (empty array) on any RPC error, matching this feature's
   * "never block or throw into the pipeline" contract.
   */
  private async resolveRecentBuyEvents(mint: string): Promise<ResolvedBuyEvent[]> {
    try {
      const mintPubkey: PublicKeyType = new PublicKey(mint);
      const signatures = await this.deps.connection.getSignaturesForAddress(mintPubkey, {
        limit: RECENT_BUY_LOOKBACK_LIMIT,
      });
      const usable = signatures.filter((s) => !s.err);
      if (usable.length === 0) return [];

      const txs = await Promise.all(
        usable.map((s) =>
          this.deps.connection
            .getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
            .catch(() => null),
        ),
      );

      const events: ResolvedBuyEvent[] = [];
      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i];
        const sig = usable[i]!;
        if (!tx) continue;
        const buyer = extractBuyerFromTransaction(tx, mint);
        if (!buyer) continue;
        events.push({
          ...buyer,
          signature: sig.signature,
          timestampMs: (sig.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
        });
      }
      return events;
    } catch (err) {
      this.deps.logger.debug({ mint, err }, 'smartWalletTracker: buy-event resolution failed');
      return [];
    }
  }

  private async upsertWallet(address: string): Promise<SmartWallet> {
    return this.deps.prisma.smartWallet.upsert({
      where: { address },
      create: { address },
      update: {},
    });
  }

  private async recordTokenEntry(
    mint: string,
    tokenId: string | undefined,
    event: ResolvedBuyEvent,
    poolCreatedAtMs: number | undefined,
    // Approximate — sampled at evaluation time (moments after the buy, not
    // the exact buy-tx execution price), not derived from the transaction
    // itself. Documented proxy, same honesty convention as getTopHolder's
    // "not a verified deployer identity" — good enough for the wallet's own
    // later ROI-vs-later-mark tracking, not a precise fill price.
    approxEntryPriceUsd: number | undefined,
  ): Promise<void> {
    const secondsAfterPoolCreation =
      poolCreatedAtMs !== undefined
        ? Math.max(0, Math.round((event.timestampMs - poolCreatedAtMs) / 1000))
        : undefined;
    await this.deps.prisma.smartWalletTokenEntry
      .upsert({
        where: {
          walletAddress_mint_entrySignature: {
            walletAddress: event.walletAddress,
            mint,
            entrySignature: event.signature,
          },
        },
        create: {
          walletAddress: event.walletAddress,
          mint,
          tokenId,
          entrySignature: event.signature,
          entryAt: new Date(event.timestampMs),
          secondsAfterPoolCreation,
          entryPriceUsd: approxEntryPriceUsd,
        },
        update: {},
      })
      .catch((err: unknown) => {
        this.deps.logger.debug(
          { mint, walletAddress: event.walletAddress, err },
          'smartWalletTracker: recordTokenEntry failed — non-fatal',
        );
      });
  }

  /**
   * Reads this wallet's resolved SmartWalletTokenEntry rows, recomputes its
   * aggregate confidence via the pure computeWalletConfidence, and writes the
   * result back onto the SmartWallet row.
   */
  async recomputeWalletConfidence(walletAddress: string): Promise<void> {
    const entries = await this.deps.prisma.smartWalletTokenEntry.findMany({
      where: { walletAddress },
      select: {
        entryAt: true,
        secondsAfterPoolCreation: true,
        status: true,
        realizedRoiPercent: true,
        unrealizedRoiPercent: true,
        isRugOrScam: true,
      },
    });
    const summaries: WalletEntrySummary[] = entries.map((e) => ({
      entryAt: e.entryAt,
      secondsAfterPoolCreation: e.secondsAfterPoolCreation ?? undefined,
      status: e.status,
      realizedRoiPercent: e.realizedRoiPercent ?? undefined,
      unrealizedRoiPercent: e.unrealizedRoiPercent ?? undefined,
      isRugOrScam: e.isRugOrScam,
    }));
    const result = computeWalletConfidence(summaries, Date.now());
    await this.deps.prisma.smartWallet.update({
      where: { address: walletAddress },
      data: {
        confidenceScore: result.confidenceScore ?? null,
        sampleSize: result.sampleSize,
        medianRoiPercent: result.medianRoiPercent ?? null,
        avgRoiPercent: result.avgRoiPercent ?? null,
        earlyEntryRatePct: result.earlyEntryRatePct ?? null,
        rugExposureRatePct: result.rugExposureRatePct ?? null,
        lastScoredAt: new Date(),
      },
    });
  }

  /**
   * Orchestration entry point. Never throws — a failure anywhere in wallet
   * resolution degrades to an empty evaluation (undefined score), matching
   * this feature's "shadow-mode analysis must never affect the fast path or
   * throw into the pipeline" contract.
   */
  async evaluateForToken(
    mint: string,
    tokenId: string | undefined,
    poolCreatedAtMs: number | undefined,
    approxEntryPriceUsd?: number,
  ): Promise<SmartMoneyEvaluation> {
    try {
      const buyEvents = await this.resolveRecentBuyEvents(mint);
      if (buyEvents.length === 0) return EMPTY_EVALUATION;

      const wallets = await Promise.all(
        buyEvents.map(async (ev) => {
          const wallet = await this.upsertWallet(ev.walletAddress);
          await this.recordTokenEntry(mint, tokenId, ev, poolCreatedAtMs, approxEntryPriceUsd);
          return wallet;
        }),
      );

      // Fire-and-forget recompute so a wallet's confidence reflects this new
      // entry on its NEXT evaluation — never awaited inline here, since it
      // would just re-read what was already just written this pass and add
      // latency for no benefit this evaluation.
      for (const wallet of wallets) {
        void this.recomputeWalletConfidence(wallet.address).catch((err: unknown) =>
          this.deps.logger.debug(
            { address: wallet.address, err },
            'recomputeWalletConfidence failed',
          ),
        );
      }

      const sybilConfidenceByWallet = new Map<string, number>();
      for (const wallet of wallets) {
        if (wallet.sybilConfidencePct)
          sybilConfidenceByWallet.set(wallet.address, wallet.sybilConfidencePct);
      }

      const walletBuys: WalletBuyEvent[] = buyEvents.map((ev, i) => ({
        walletAddress: ev.walletAddress,
        confidenceScore: wallets[i]!.confidenceScore ?? undefined,
        sybilClusterId: wallets[i]!.sybilClusterId ?? undefined,
        timestampMs: ev.timestampMs,
      }));
      const discounted = applySybilDiscount(walletBuys, sybilConfidenceByWallet);
      const clusterBuy = detectClusterBuy(discounted);
      const smartMoneyScore = computeSmartMoneyScore(discounted, clusterBuy);

      return {
        smartMoneyScore,
        clusterBuy,
        buyEvents,
        sybilDiscountApplied: sybilConfidenceByWallet.size > 0,
      };
    } catch (err) {
      this.deps.logger.debug({ mint, err }, 'smartWalletTracker: evaluateForToken failed');
      return EMPTY_EVALUATION;
    }
  }
}
