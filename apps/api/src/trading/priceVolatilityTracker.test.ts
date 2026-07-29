import { describe, expect, it } from 'vitest';
import { PriceVolatilityTracker } from './priceVolatilityTracker.js';

describe('PriceVolatilityTracker', () => {
  it('returns undefined with fewer than 5 samples', () => {
    const tracker = new PriceVolatilityTracker();
    tracker.recordSample('pos-1', 1, 0);
    tracker.recordSample('pos-1', 1.1, 1000);
    expect(tracker.getRollingStdDevPercent('pos-1')).toBeUndefined();
  });

  it('returns undefined for a position that has never recorded a sample', () => {
    const tracker = new PriceVolatilityTracker();
    expect(tracker.getRollingStdDevPercent('never-seen')).toBeUndefined();
  });

  it('computes a known stddev from a known price series', () => {
    const tracker = new PriceVolatilityTracker();
    // Returns: 0%, 10%, -9.09...%, 0%, 10% (5 returns from 6 prices) —
    // verifies the population-stddev formula against a hand-computed value.
    const prices = [1, 1, 1.1, 1, 1, 1.1];
    prices.forEach((p, i) => tracker.recordSample('pos-1', p, i * 1000));

    const returns = [0, 10, -100 / 11, 0, 10];
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const expected = Math.sqrt(variance);

    expect(tracker.getRollingStdDevPercent('pos-1')).toBeCloseTo(expected, 6);
  });

  it('ignores non-finite or non-positive price samples', () => {
    const tracker = new PriceVolatilityTracker();
    tracker.recordSample('pos-1', 1, 0);
    tracker.recordSample('pos-1', NaN, 1000);
    tracker.recordSample('pos-1', -5, 2000);
    tracker.recordSample('pos-1', 0, 3000);
    tracker.recordSample('pos-1', 1.05, 4000);
    tracker.recordSample('pos-1', 1.1, 5000);
    // Only 3 valid samples were actually recorded (1, 1.05, 1.1) — still
    // below the 5-sample floor.
    expect(tracker.getRollingStdDevPercent('pos-1')).toBeUndefined();
  });

  it('evicts samples older than maxSampleAgeMs', () => {
    const tracker = new PriceVolatilityTracker(20, 5000); // 5s max age
    for (let i = 0; i < 5; i++) tracker.recordSample('pos-1', 1 + i * 0.01, i * 1000);
    expect(tracker.getRollingStdDevPercent('pos-1')).toBeDefined();

    // A sample far in the future should evict everything older than 5s
    // before it, dropping back under the 5-sample floor.
    tracker.recordSample('pos-1', 2, 100_000);
    expect(tracker.getRollingStdDevPercent('pos-1')).toBeUndefined();
  });

  it('evicts down to maxSamples, keeping only the most recent', () => {
    const tracker = new PriceVolatilityTracker(5, 10 * 60_000);
    for (let i = 0; i < 100; i++) tracker.recordSample('pos-1', 1 + (i % 2) * 0.5, i * 1000);
    // With only 5 kept, stddev should still be computable and stable, not
    // growing unboundedly with sample count.
    const stddev = tracker.getRollingStdDevPercent('pos-1');
    expect(stddev).toBeDefined();
    expect(stddev).toBeGreaterThan(0);
  });

  it('tracks multiple positions independently', () => {
    const tracker = new PriceVolatilityTracker();
    for (let i = 0; i < 6; i++) tracker.recordSample('pos-flat', 1, i * 1000);
    for (let i = 0; i < 6; i++) tracker.recordSample('pos-volatile', 1 + (i % 2), i * 1000);

    expect(tracker.getRollingStdDevPercent('pos-flat')).toBe(0);
    expect(tracker.getRollingStdDevPercent('pos-volatile')).toBeGreaterThan(0);
  });

  it('forget() releases a position so it reports undefined again', () => {
    const tracker = new PriceVolatilityTracker();
    for (let i = 0; i < 6; i++) tracker.recordSample('pos-1', 1 + i * 0.01, i * 1000);
    expect(tracker.getRollingStdDevPercent('pos-1')).toBeDefined();

    tracker.forget('pos-1');
    expect(tracker.getRollingStdDevPercent('pos-1')).toBeUndefined();
  });
});
