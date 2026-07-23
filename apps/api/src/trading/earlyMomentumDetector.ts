import type { Logger } from '@nova/shared';
import type { DexScreenerClient, DexScreenerPair } from '../solana/dexscreener.js';

/**
 * Early Pump Detection (Sections 3-4, 2026-07-22). Pure scoring/heuristic
 * functions here (same convention as smartWalletTracker.ts); the I/O
 * orchestration (EarlyMomentumDetectorService, bottom of file) reuses the
 * shared DexScreenerClient instance — never its own client — so it inherits
 * that client's existing cache/dedup/timeout for free.
 *
 * Acceleration metrics are derived from a SINGLE DexScreener snapshot's own
 * multi-window fields (m5 vs h1 vs h24), not a second time-delayed fetch —
 * this evaluation runs once per token, and DexScreener already reports
 * several historical windows in one response, so comparing them is a real
 * acceleration signal without any extra HTTP round trip.
 */

export interface EarlyMomentumMetrics {
  buySellRatio?: number;
  /** Count of unique buyer wallets observed in the evaluation window (from
   * SmartWalletTracker's buy-event resolution). */
  uniqueBuyerGrowthRate?: number;
  txAccelerationPct?: number;
  volumeAccelerationPct?: number;
  liquidityGrowthPct?: number;
  priceAccelerationPct?: number;
  holderGrowthCount?: number;
  smartMoneyInflowUsd?: number;
  /** 0-100 — high value penalizes/caps the score, see below. */
  repeatedBuyerRatioPct?: number;
  /** 0-100 — high value penalizes/caps the score, see below. */
  washTradeSuspicionPct?: number;
}

interface WeightedComponent {
  value: number | undefined;
  weight: number;
  /** Value that earns the full weight — linear scale from 0 up to this cap. */
  fullCreditAt: number;
}

/**
 * Weight-renormalized average over whichever positive components are
 * present, same undefined-exclusion convention as
 * packages/shared/src/opportunityScore.ts's calculateOpportunityScore — a
 * missing metric is excluded from both numerator and denominator, never
 * treated as 0. Positive weights sum to 100 when every component is present
 * and maxed. repeatedBuyerRatioPct/washTradeSuspicionPct are NOT part of this
 * weighted average — they're applied afterward as caps (see below), since a
 * strong positive score should never simply "average away" a real
 * wash-trading suspicion.
 */
export function computeEarlyMomentumScore(metrics: EarlyMomentumMetrics): {
  score: number;
  breakdown: EarlyMomentumMetrics;
} {
  const components: WeightedComponent[] = [
    { value: metrics.buySellRatio, weight: 15, fullCreditAt: 2 },
    { value: metrics.uniqueBuyerGrowthRate, weight: 15, fullCreditAt: 20 },
    { value: metrics.txAccelerationPct, weight: 10, fullCreditAt: 100 },
    { value: metrics.volumeAccelerationPct, weight: 15, fullCreditAt: 100 },
    { value: metrics.liquidityGrowthPct, weight: 15, fullCreditAt: 50 },
    { value: metrics.priceAccelerationPct, weight: 10, fullCreditAt: 50 },
    { value: metrics.holderGrowthCount, weight: 10, fullCreditAt: 10 },
    { value: metrics.smartMoneyInflowUsd, weight: 10, fullCreditAt: 5000 },
  ];

  let weightedSum = 0;
  let weightTotal = 0;
  for (const c of components) {
    if (c.value === undefined) continue;
    const credit = Math.max(0, Math.min(1, c.value / c.fullCreditAt));
    weightedSum += credit * c.weight;
    weightTotal += c.weight;
  }

  let score = weightTotal > 0 ? (weightedSum / weightTotal) * 100 : 0;

  // Caps, not subtraction — a token with genuinely strong organic metrics but
  // also real wash-trading suspicion should read as "suspicious," not merely
  // "slightly lower," since the underlying volume/tx numbers feeding the
  // score above may themselves be fabricated.
  if (metrics.washTradeSuspicionPct !== undefined) {
    if (metrics.washTradeSuspicionPct >= 70) score = Math.min(score, 20);
    else if (metrics.washTradeSuspicionPct >= 40) score = Math.min(score, 50);
  }
  if (metrics.repeatedBuyerRatioPct !== undefined && metrics.repeatedBuyerRatioPct > 50) {
    score = Math.min(score, 100 - (metrics.repeatedBuyerRatioPct - 50));
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), breakdown: metrics };
}

export interface BuyEvent {
  walletAddress: string;
  side: 'buy' | 'sell';
  amountUsd?: number;
  timestampMs: number;
}

/** A wallet appearing >=2 times with both a buy and a sell within this window
 * is a same-wallet-round-trip candidate. */
const ROUND_TRIP_WINDOW_MS = 2 * 60 * 1000;
const TIGHT_SIZE_COEFFICIENT_OF_VARIATION = 0.05;

/**
 * Pure heuristic over a token's own recent buy/sell events (not a network-wide
 * scan): flags (a) same-wallet tight buy/sell round trips, (b) many
 * near-identical repeated trade sizes, (c) a small set of wallets accounting
 * for a disproportionate share of total tx count. Feeds into
 * computeEarlyMomentumScore's cap above rather than the caller having to
 * remember to apply it separately.
 */
export function detectWashTradingPattern(events: BuyEvent[]): {
  suspicionPct: number;
  reasons: string[];
} {
  if (events.length === 0) return { suspicionPct: 0, reasons: [] };

  const reasons: string[] = [];
  let suspicionPct = 0;

  const byWallet = new Map<string, BuyEvent[]>();
  for (const e of events) {
    const list = byWallet.get(e.walletAddress);
    if (list) list.push(e);
    else byWallet.set(e.walletAddress, [e]);
  }

  let roundTripWallets = 0;
  for (const walletEvents of byWallet.values()) {
    const buys = walletEvents.filter((e) => e.side === 'buy');
    const sells = walletEvents.filter((e) => e.side === 'sell');
    if (buys.length === 0 || sells.length === 0) continue;
    const roundTrip = buys.some((b) =>
      sells.some((s) => Math.abs(s.timestampMs - b.timestampMs) <= ROUND_TRIP_WINDOW_MS),
    );
    if (roundTrip) roundTripWallets++;
  }
  const roundTripRatio = roundTripWallets / byWallet.size;
  if (roundTripRatio > 0.3) {
    suspicionPct += 40;
    reasons.push('same_wallet_round_trips');
  }

  const amounts = events.map((e) => e.amountUsd).filter((a): a is number => a !== undefined);
  if (amounts.length >= 5) {
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance = amounts.reduce((sum, v) => sum + (v - mean) ** 2, 0) / amounts.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    if (cv <= TIGHT_SIZE_COEFFICIENT_OF_VARIATION) {
      suspicionPct += 30;
      reasons.push('near_identical_trade_sizes');
    }
  }

  if (byWallet.size >= 5) {
    const countsByWallet = [...byWallet.values()].map((v) => v.length).sort((a, b) => b - a);
    const top3 = countsByWallet.slice(0, 3).reduce((a, b) => a + b, 0);
    const total = countsByWallet.reduce((a, b) => a + b, 0);
    if (top3 / total > 0.6) {
      suspicionPct += 30;
      reasons.push('concentrated_tx_count');
    }
  }

  return { suspicionPct: Math.max(0, Math.min(100, suspicionPct)), reasons };
}

/**
 * Derives EarlyMomentumMetrics purely from a DexScreener pair snapshot plus
 * optional wallet-level context (from SmartWalletTracker) — pure, so the
 * derivation logic is testable without a real DexScreener fetch.
 */
export function deriveMomentumMetricsFromPair(
  pair: DexScreenerPair | undefined,
  opts: {
    uniqueBuyerCount?: number;
    smartMoneyInflowUsd?: number;
    washTradeSuspicionPct?: number;
    repeatedBuyerRatioPct?: number;
  } = {},
): EarlyMomentumMetrics {
  if (!pair) {
    return {
      uniqueBuyerGrowthRate: opts.uniqueBuyerCount,
      smartMoneyInflowUsd: opts.smartMoneyInflowUsd,
      washTradeSuspicionPct: opts.washTradeSuspicionPct,
      repeatedBuyerRatioPct: opts.repeatedBuyerRatioPct,
    };
  }

  const m5 = pair.txns?.m5;
  const h1 = pair.txns?.h1;
  const buySellRatio =
    m5 && (m5.buys > 0 || m5.sells > 0)
      ? m5.buys / Math.max(m5.sells, 1)
      : h1 && (h1.buys > 0 || h1.sells > 0)
        ? h1.buys / Math.max(h1.sells, 1)
        : undefined;

  const m5TxRateHourly = m5 ? (m5.buys + m5.sells) * 12 : undefined;
  const h1TxRate = h1 ? h1.buys + h1.sells : undefined;
  const txAccelerationPct =
    m5TxRateHourly !== undefined && h1TxRate !== undefined && h1TxRate > 0
      ? ((m5TxRateHourly - h1TxRate) / h1TxRate) * 100
      : undefined;

  const m5VolumeHourly = pair.volume?.m5 !== undefined ? pair.volume.m5 * 12 : undefined;
  const h1Volume = pair.volume?.h1;
  const volumeAccelerationPct =
    m5VolumeHourly !== undefined && h1Volume !== undefined && h1Volume > 0
      ? ((m5VolumeHourly - h1Volume) / h1Volume) * 100
      : undefined;

  const h1Change = pair.priceChange?.h1;
  const h24Change = pair.priceChange?.h24;
  const priceAccelerationPct =
    h1Change !== undefined && h24Change !== undefined ? h1Change - h24Change / 24 : undefined;

  return {
    buySellRatio,
    txAccelerationPct,
    volumeAccelerationPct,
    priceAccelerationPct,
    uniqueBuyerGrowthRate: opts.uniqueBuyerCount,
    smartMoneyInflowUsd: opts.smartMoneyInflowUsd,
    washTradeSuspicionPct: opts.washTradeSuspicionPct,
    repeatedBuyerRatioPct: opts.repeatedBuyerRatioPct,
  };
}

export type MomentumScoreOpts = {
  uniqueBuyerCount?: number;
  smartMoneyInflowUsd?: number;
  washTradeSuspicionPct?: number;
  repeatedBuyerRatioPct?: number;
};

export interface MomentumSampleResult {
  score: number;
  breakdown: EarlyMomentumMetrics;
  /** The pair's current priceUsd, if available — surfaced so a caller (the
   * shadow-mode logger) can record priceAtDetectionUsd without a second
   * DexScreener fetch. */
  priceUsd?: number;
}

export interface EarlyMomentumDetectorDeps {
  dexScreener: DexScreenerClient;
  logger: Logger;
}

export class EarlyMomentumDetectorService {
  constructor(private readonly deps: EarlyMomentumDetectorDeps) {}

  /**
   * Fetches the current DexScreener pair via the shared, already-cached
   * client — split out from scoring (below) so an orchestrator can fetch this
   * concurrently with an independent wallet-evaluation call rather than
   * waiting on it first. Never throws — a fetch failure resolves to
   * undefined, same as a token DexScreener simply hasn't indexed yet.
   */
  async fetchPair(mint: string): Promise<DexScreenerPair | undefined> {
    try {
      return await this.deps.dexScreener.getBestSolanaPair(mint);
    } catch (err) {
      this.deps.logger.debug({ mint, err }, 'earlyMomentumDetector: pair fetch failed');
      return undefined;
    }
  }

  /** Pure combination of an already-fetched pair (or undefined) with
   * wallet-level context — never throws, never does I/O. */
  scoreFromPair(
    pair: DexScreenerPair | undefined,
    opts: MomentumScoreOpts = {},
  ): MomentumSampleResult {
    const metrics = deriveMomentumMetricsFromPair(pair, opts);
    const { score, breakdown } = computeEarlyMomentumScore(metrics);
    const priceUsd = pair?.priceUsd !== undefined ? Number(pair.priceUsd) : undefined;
    return { score, breakdown, priceUsd: Number.isFinite(priceUsd) ? priceUsd : undefined };
  }

  /** Convenience wrapper (fetch + score) for standalone callers/tests that
   * don't need the fetch/score split above. */
  async sampleMomentum(mint: string, opts: MomentumScoreOpts = {}): Promise<MomentumSampleResult> {
    const pair = await this.fetchPair(mint);
    return this.scoreFromPair(pair, opts);
  }
}
