import type { DexScreenerPair } from '../solana/dexscreener.js';

/**
 * Wait-for-confirmation entry (ENTRY_CONFIRMATION_DELAY_MS): most fresh
 * launches collapse within their first minutes, so instead of buying on
 * detection a young token is re-checked once it reaches the configured age and
 * only bought if its price and liquidity held up in the meantime.
 */

export interface MarketSnapshot {
  priceUsd?: number;
  liquidityUsd?: number;
}

export function snapshotFromPair(pair: DexScreenerPair | undefined): MarketSnapshot {
  const price = pair?.priceUsd !== undefined ? Number(pair.priceUsd) : undefined;
  return {
    priceUsd: price !== undefined && Number.isFinite(price) && price > 0 ? price : undefined,
    liquidityUsd: pair?.liquidity?.usd,
  };
}

export interface ConfirmationOptions {
  maxPriceDropPercent: number;
  maxLiquidityDropPercent: number;
}

export function evaluateConfirmation(
  initial: MarketSnapshot,
  fresh: MarketSnapshot,
  opts: ConfirmationOptions,
): { confirmed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (fresh.priceUsd === undefined) {
    reasons.push('no_market_data');
    return { confirmed: false, reasons };
  }
  if (initial.priceUsd !== undefined) {
    const changePercent = ((fresh.priceUsd - initial.priceUsd) / initial.priceUsd) * 100;
    if (changePercent < -opts.maxPriceDropPercent) {
      reasons.push(`price_dropped_${changePercent.toFixed(1)}%`);
    }
  }
  if (initial.liquidityUsd !== undefined && initial.liquidityUsd > 0) {
    const liquidity = fresh.liquidityUsd ?? 0;
    const changePercent = ((liquidity - initial.liquidityUsd) / initial.liquidityUsd) * 100;
    if (changePercent < -opts.maxLiquidityDropPercent) {
      reasons.push(`liquidity_dropped_${changePercent.toFixed(1)}%`);
    }
  }
  return { confirmed: reasons.length === 0, reasons };
}

/** In-memory delayed re-checks, one per mint, bounded so a launch storm can't grow it unboundedly. */
export class ConfirmationScheduler {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly maxPending = 300) {}

  /** Returns false when this mint is already waiting or the queue is full. */
  schedule(
    mint: string,
    delayMs: number,
    run: () => Promise<void>,
    onError: (err: unknown) => void,
  ): boolean {
    if (this.pending.has(mint) || this.pending.size >= this.maxPending) return false;
    const timer = setTimeout(
      () => {
        this.pending.delete(mint);
        run().catch(onError);
      },
      Math.max(0, delayMs),
    );
    timer.unref?.();
    this.pending.set(mint, timer);
    return true;
  }

  get size(): number {
    return this.pending.size;
  }

  stop(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
