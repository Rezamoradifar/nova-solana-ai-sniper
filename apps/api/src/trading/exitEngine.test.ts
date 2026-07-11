import { describe, expect, it } from 'vitest';
import { evaluateExit, isPlausiblePriceUpdate } from './exitEngine.js';

describe('evaluateExit', () => {
  it('triggers take profit when pnl exceeds threshold', () => {
    const result = evaluateExit({
      entryPriceUsd: 1,
      currentPriceUsd: 1.5,
      highWaterMarkUsd: 1.5,
      takeProfitPercent: 40,
    });
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('take_profit');
    expect(result.pnlPercent).toBeCloseTo(50);
  });

  it('triggers stop loss when price drops below threshold', () => {
    const result = evaluateExit({
      entryPriceUsd: 1,
      currentPriceUsd: 0.8,
      highWaterMarkUsd: 1,
      stopLossPercent: 15,
    });
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('stop_loss');
  });

  it('triggers trailing stop after retracing from a high', () => {
    const result = evaluateExit({
      entryPriceUsd: 1,
      currentPriceUsd: 1.7,
      highWaterMarkUsd: 2,
      trailingStopPercent: 10,
    });
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('trailing_stop');
  });

  it('does not exit when no thresholds are breached', () => {
    const result = evaluateExit({
      entryPriceUsd: 1,
      currentPriceUsd: 1.05,
      highWaterMarkUsd: 1.05,
      takeProfitPercent: 40,
      stopLossPercent: 15,
      trailingStopPercent: 10,
    });
    expect(result.shouldExit).toBe(false);
  });

  it('never exits on take-profit/stop-loss from an unknown (zero) entry price', () => {
    // A real bug: an automated auto-buy path once recorded entryPriceUsd=0 as a
    // placeholder. (current - 0) / 0 is Infinity, which trivially "beats" any
    // take-profit threshold and closes the position within one price tick,
    // regardless of what the price actually did.
    const result = evaluateExit({
      entryPriceUsd: 0,
      currentPriceUsd: 0.000002283,
      highWaterMarkUsd: 0,
      takeProfitPercent: 25,
      stopLossPercent: 10,
    });
    expect(result.shouldExit).toBe(false);
    expect(result.pnlPercent).toBe(0);
  });

  it('still evaluates trailing stop correctly even with an unknown entry price', () => {
    // Trailing stop only compares currentPriceUsd against its own high-water mark,
    // not entryPriceUsd, so it must keep working regardless of the guard above.
    const result = evaluateExit({
      entryPriceUsd: 0,
      currentPriceUsd: 0.8,
      highWaterMarkUsd: 1,
      trailingStopPercent: 15,
    });
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('trailing_stop');
  });

  it('updates the high water mark even when not exiting', () => {
    const result = evaluateExit({
      entryPriceUsd: 1,
      currentPriceUsd: 1.3,
      highWaterMarkUsd: 1.1,
      trailingStopPercent: 50,
    });
    expect(result.newHighWaterMarkUsd).toBe(1.3);
  });
});

describe('isPlausiblePriceUpdate', () => {
  it('accepts a normal tick-to-tick price move', () => {
    expect(isPlausiblePriceUpdate(0.0000041, 0.0000042)).toBe(true);
    expect(isPlausiblePriceUpdate(0.0000041, 0.0000038)).toBe(true);
  });

  it('rejects the live-verified BONK incident: a ~5000x single-tick outlier', () => {
    expect(isPlausiblePriceUpdate(0.000004079, 0.02151)).toBe(false);
  });

  it('rejects an implausible single-tick crash toward zero', () => {
    expect(isPlausiblePriceUpdate(1, 0.0001)).toBe(false);
  });

  it('accepts a genuinely large but real multi-day move (called across many ticks, not one)', () => {
    // A real 10x over a day happens as many small per-tick deltas, each well
    // under the 20x ceiling — this checks the ceiling itself isn't so tight
    // it would reject a single legitimately large but plausible tick.
    expect(isPlausiblePriceUpdate(1, 10)).toBe(true);
  });

  it('rejects a non-finite or non-positive candidate price', () => {
    expect(isPlausiblePriceUpdate(1, NaN)).toBe(false);
    expect(isPlausiblePriceUpdate(1, 0)).toBe(false);
    expect(isPlausiblePriceUpdate(1, -5)).toBe(false);
  });

  it('accepts anything when there is no reference price yet (nothing to compare against)', () => {
    expect(isPlausiblePriceUpdate(0, 12345)).toBe(true);
  });
});
