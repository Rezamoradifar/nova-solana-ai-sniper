import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfirmationScheduler,
  evaluateConfirmation,
  snapshotFromPair,
} from './entryConfirmation.js';

const opts = { maxPriceDropPercent: 15, maxLiquidityDropPercent: 30 };

describe('evaluateConfirmation', () => {
  it('confirms a token that held its price and liquidity', () => {
    expect(
      evaluateConfirmation(
        { priceUsd: 1, liquidityUsd: 20000 },
        { priceUsd: 1.3, liquidityUsd: 26000 },
        opts,
      ).confirmed,
    ).toBe(true);
  });
  it('rejects a token whose price collapsed', () => {
    const v = evaluateConfirmation(
      { priceUsd: 1, liquidityUsd: 20000 },
      { priceUsd: 0.5, liquidityUsd: 20000 },
      opts,
    );
    expect(v.confirmed).toBe(false);
    expect(v.reasons[0]).toMatch(/^price_dropped/);
  });
  it('rejects a token whose liquidity was pulled', () => {
    const v = evaluateConfirmation(
      { priceUsd: 1, liquidityUsd: 20000 },
      { priceUsd: 1, liquidityUsd: 5000 },
      opts,
    );
    expect(v.reasons[0]).toMatch(/^liquidity_dropped/);
  });
  it('rejects when there is no market data at re-check time', () => {
    expect(evaluateConfirmation({}, {}, opts)).toEqual({
      confirmed: false,
      reasons: ['no_market_data'],
    });
  });
});

describe('snapshotFromPair', () => {
  it('parses DexScreener price and liquidity', () => {
    expect(snapshotFromPair({ priceUsd: '0.0001', liquidity: { usd: 15000 } } as never)).toEqual({
      priceUsd: 0.0001,
      liquidityUsd: 15000,
    });
    expect(snapshotFromPair(undefined)).toEqual({ priceUsd: undefined, liquidityUsd: undefined });
  });
});

describe('ConfirmationScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('runs once after the delay and dedupes the same mint', async () => {
    vi.useFakeTimers();
    const scheduler = new ConfirmationScheduler(10);
    const run = vi.fn().mockResolvedValue(undefined);
    expect(scheduler.schedule('M', 1000, run, vi.fn())).toBe(true);
    expect(scheduler.schedule('M', 1000, run, vi.fn())).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.size).toBe(0);
  });
  it('refuses new work when full', () => {
    const scheduler = new ConfirmationScheduler(1);
    expect(scheduler.schedule('A', 60_000, vi.fn(), vi.fn())).toBe(true);
    expect(scheduler.schedule('B', 60_000, vi.fn(), vi.fn())).toBe(false);
    scheduler.stop();
  });
});
