import { describe, it, expect } from 'vitest';
import {
  computeEarlyMomentumScore,
  detectWashTradingPattern,
  deriveMomentumMetricsFromPair,
  type EarlyMomentumMetrics,
  type BuyEvent,
} from './earlyMomentumDetector.js';
import type { DexScreenerPair } from '../solana/dexscreener.js';

describe('computeEarlyMomentumScore', () => {
  it('returns 0 when every component is undefined', () => {
    const result = computeEarlyMomentumScore({});
    expect(result.score).toBe(0);
  });

  it('excludes missing components from the weighted average rather than treating them as 0', () => {
    const partial: EarlyMomentumMetrics = { buySellRatio: 2 };
    const result = computeEarlyMomentumScore(partial);
    // With only buySellRatio present and maxed, the renormalized average
    // should be the maximum (100), not diluted by all the missing components.
    expect(result.score).toBe(100);
  });

  it('scores higher for stronger metrics across the board', () => {
    const weak: EarlyMomentumMetrics = { buySellRatio: 1, volumeAccelerationPct: 10 };
    const strong: EarlyMomentumMetrics = { buySellRatio: 3, volumeAccelerationPct: 200 };
    expect(computeEarlyMomentumScore(strong).score).toBeGreaterThan(
      computeEarlyMomentumScore(weak).score,
    );
  });

  it('caps the score hard when wash-trade suspicion is high, regardless of other metrics', () => {
    const strongButSuspicious: EarlyMomentumMetrics = {
      buySellRatio: 5,
      volumeAccelerationPct: 500,
      liquidityGrowthPct: 100,
      washTradeSuspicionPct: 80,
    };
    const result = computeEarlyMomentumScore(strongButSuspicious);
    expect(result.score).toBeLessThanOrEqual(20);
  });

  it('caps the score when repeated-buyer ratio is high', () => {
    const metrics: EarlyMomentumMetrics = {
      buySellRatio: 5,
      volumeAccelerationPct: 500,
      repeatedBuyerRatioPct: 90,
    };
    const result = computeEarlyMomentumScore(metrics);
    expect(result.score).toBeLessThan(100);
  });

  it('never returns a score outside 0-100', () => {
    const result = computeEarlyMomentumScore({
      buySellRatio: 1000,
      volumeAccelerationPct: 1_000_000,
      liquidityGrowthPct: 1_000_000,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

function buyEvent(overrides: Partial<BuyEvent> = {}): BuyEvent {
  return { walletAddress: 'wallet', side: 'buy', timestampMs: 0, ...overrides };
}

describe('detectWashTradingPattern', () => {
  it('returns 0 suspicion for an empty event list', () => {
    expect(detectWashTradingPattern([]).suspicionPct).toBe(0);
  });

  it('flags same-wallet tight buy/sell round trips', () => {
    const events: BuyEvent[] = [];
    for (let i = 0; i < 6; i++) {
      events.push(buyEvent({ walletAddress: `w${i}`, side: 'buy', timestampMs: i * 10_000 }));
      events.push(
        buyEvent({ walletAddress: `w${i}`, side: 'sell', timestampMs: i * 10_000 + 5000 }),
      );
    }
    const result = detectWashTradingPattern(events);
    expect(result.suspicionPct).toBeGreaterThan(0);
    expect(result.reasons).toContain('same_wallet_round_trips');
  });

  it('flags near-identical repeated trade sizes', () => {
    const events: BuyEvent[] = Array.from({ length: 6 }, (_, i) =>
      buyEvent({ walletAddress: `w${i}`, amountUsd: 100 + i * 0.01, timestampMs: i * 60_000 }),
    );
    const result = detectWashTradingPattern(events);
    expect(result.reasons).toContain('near_identical_trade_sizes');
  });

  it('flags a small set of wallets accounting for a disproportionate tx count', () => {
    const events: BuyEvent[] = [
      ...Array.from({ length: 20 }, (_, i) =>
        buyEvent({ walletAddress: 'whale1', timestampMs: i }),
      ),
      buyEvent({ walletAddress: 'other1', timestampMs: 1000 }),
      buyEvent({ walletAddress: 'other2', timestampMs: 1001 }),
      buyEvent({ walletAddress: 'other3', timestampMs: 1002 }),
      buyEvent({ walletAddress: 'other4', timestampMs: 1003 }),
    ];
    const result = detectWashTradingPattern(events);
    expect(result.reasons).toContain('concentrated_tx_count');
  });

  it('does not flag genuinely organic-looking activity', () => {
    const events: BuyEvent[] = Array.from({ length: 8 }, (_, i) =>
      buyEvent({ walletAddress: `organic${i}`, amountUsd: 50 + i * 37, timestampMs: i * 45_000 }),
    );
    const result = detectWashTradingPattern(events);
    expect(result.suspicionPct).toBe(0);
  });
});

function pair(overrides: Partial<DexScreenerPair> = {}): DexScreenerPair {
  return {
    chainId: 'solana',
    dexId: 'pumpfun',
    pairAddress: 'pair1',
    baseToken: { address: 'mint1', name: 'Test', symbol: 'TST' },
    quoteToken: { address: 'sol', name: 'Wrapped SOL', symbol: 'SOL' },
    ...overrides,
  };
}

describe('deriveMomentumMetricsFromPair', () => {
  it('returns only wallet-level context when no pair is available', () => {
    const metrics = deriveMomentumMetricsFromPair(undefined, { uniqueBuyerCount: 5 });
    expect(metrics.uniqueBuyerGrowthRate).toBe(5);
    expect(metrics.buySellRatio).toBeUndefined();
  });

  it('derives buySellRatio from the m5 window when it has activity', () => {
    const p = pair({ txns: { m5: { buys: 10, sells: 2 } } });
    const metrics = deriveMomentumMetricsFromPair(p);
    expect(metrics.buySellRatio).toBe(5);
  });

  it('falls back to h1 when m5 has no activity', () => {
    const p = pair({ txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 8, sells: 4 } } });
    const metrics = deriveMomentumMetricsFromPair(p);
    expect(metrics.buySellRatio).toBe(2);
  });

  it('derives positive txAccelerationPct when the m5-extrapolated rate exceeds h1', () => {
    const p = pair({ txns: { m5: { buys: 10, sells: 10 }, h1: { buys: 20, sells: 20 } } });
    const metrics = deriveMomentumMetricsFromPair(p);
    // m5 rate extrapolated hourly: 20*12=240; h1 rate: 40 -> big acceleration
    expect(metrics.txAccelerationPct).toBeGreaterThan(0);
  });

  it('derives volumeAccelerationPct from m5 vs h1 volume', () => {
    const p = pair({ volume: { m5: 1000, h1: 2000 } });
    const metrics = deriveMomentumMetricsFromPair(p);
    expect(metrics.volumeAccelerationPct).toBeCloseTo(((1000 * 12 - 2000) / 2000) * 100);
  });

  it('derives priceAccelerationPct from h1 vs hourly-normalized h24 change', () => {
    const p = pair({ priceChange: { h1: 10, h24: 24 } });
    const metrics = deriveMomentumMetricsFromPair(p);
    expect(metrics.priceAccelerationPct).toBe(9);
  });
});
