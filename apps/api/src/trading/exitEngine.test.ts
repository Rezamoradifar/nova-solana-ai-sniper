import { describe, expect, it } from 'vitest';
import {
  evaluateExit,
  isPlausiblePriceUpdate,
  reconcilePriceOutlier,
  resolveEffectiveStopLossPercent,
  evaluateHardLossCeiling,
  DEFAULT_MAX_LOSS_PERCENT,
} from './exitEngine.js';

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

describe('reconcilePriceOutlier', () => {
  it('accepts when corroborated by a jupiter reverse quote within tolerance', () => {
    const result = reconcilePriceOutlier({
      candidatePriceUsd: 0.02151,
      jupiterReverseQuotePriceUsd: 0.019,
    });
    expect(result).toEqual({ accepted: true, source: 'jupiter_reverse_quote' });
  });

  it('accepts when corroborated by native DEX reserves within tolerance', () => {
    const result = reconcilePriceOutlier({
      candidatePriceUsd: 0.02151,
      nativeDexReservesPriceUsd: 0.05,
    });
    expect(result).toEqual({ accepted: true, source: 'native_dex_reserves' });
  });

  it('prefers jupiter corroboration when both sources agree', () => {
    const result = reconcilePriceOutlier({
      candidatePriceUsd: 1,
      jupiterReverseQuotePriceUsd: 1.1,
      nativeDexReservesPriceUsd: 0.9,
    });
    expect(result.source).toBe('jupiter_reverse_quote');
  });

  it('rejects when neither source is available', () => {
    const result = reconcilePriceOutlier({ candidatePriceUsd: 0.02151 });
    expect(result).toEqual({ accepted: false });
  });

  it('rejects when both sources disagree with the candidate outside tolerance', () => {
    const result = reconcilePriceOutlier({
      candidatePriceUsd: 0.02151,
      jupiterReverseQuotePriceUsd: 0.000004079,
      nativeDexReservesPriceUsd: 0.000004079,
    });
    expect(result).toEqual({ accepted: false });
  });

  it('force-accepts after the ceiling even with no corroborating source', () => {
    const result = reconcilePriceOutlier({
      candidatePriceUsd: 0.02151,
      forcedAfterCeiling: true,
    });
    expect(result).toEqual({ accepted: true, source: 'forced_after_ceiling' });
  });

  it('never force-accepts unless the caller explicitly says the ceiling was hit', () => {
    const result = reconcilePriceOutlier({ candidatePriceUsd: 0.02151, forcedAfterCeiling: false });
    expect(result.accepted).toBe(false);
  });

  describe('liquidity-collapse corroboration (2026-07-23 USOH incident follow-up, requirement #12)', () => {
    it('accepts when a real liquidity collapse corroborates the crash', () => {
      const result = reconcilePriceOutlier({
        candidatePriceUsd: 0.004,
        liquidityDropCorroborates: true,
      });
      expect(result).toEqual({ accepted: true, source: 'liquidity_collapse' });
    });

    it('a price-based source still takes priority over the liquidity signal', () => {
      const result = reconcilePriceOutlier({
        candidatePriceUsd: 0.02151,
        jupiterReverseQuotePriceUsd: 0.019,
        liquidityDropCorroborates: true,
      });
      expect(result.source).toBe('jupiter_reverse_quote');
    });

    it('rejects when liquidity did not corroborate and no other source did either', () => {
      const result = reconcilePriceOutlier({
        candidatePriceUsd: 0.02151,
        liquidityDropCorroborates: false,
      });
      expect(result).toEqual({ accepted: false });
    });
  });
});

describe('resolveEffectiveStopLossPercent', () => {
  it('defaults to the ceiling when no stop loss was ever set', () => {
    expect(resolveEffectiveStopLossPercent(undefined)).toEqual({
      effectiveStopLossPercent: DEFAULT_MAX_LOSS_PERCENT,
      isSystemDefault: true,
    });
    expect(resolveEffectiveStopLossPercent(null)).toEqual({
      effectiveStopLossPercent: DEFAULT_MAX_LOSS_PERCENT,
      isSystemDefault: true,
    });
  });

  it('clamps a looser-than-ceiling value (e.g. a preset default) down to the ceiling', () => {
    expect(resolveEffectiveStopLossPercent(35)).toEqual({
      effectiveStopLossPercent: DEFAULT_MAX_LOSS_PERCENT,
      isSystemDefault: true,
    });
    expect(resolveEffectiveStopLossPercent(40)).toEqual({
      effectiveStopLossPercent: DEFAULT_MAX_LOSS_PERCENT,
      isSystemDefault: true,
    });
  });

  it('honors a tighter-than-ceiling user value unchanged', () => {
    expect(resolveEffectiveStopLossPercent(10)).toEqual({
      effectiveStopLossPercent: 10,
      isSystemDefault: false,
    });
  });

  it('honors a value exactly at the ceiling as the user value, not a default', () => {
    expect(resolveEffectiveStopLossPercent(DEFAULT_MAX_LOSS_PERCENT)).toEqual({
      effectiveStopLossPercent: DEFAULT_MAX_LOSS_PERCENT,
      isSystemDefault: false,
    });
  });
});

describe('evaluateHardLossCeiling', () => {
  it('breaches when the candidate price implies a loss beyond the effective stop-loss percent', () => {
    const result = evaluateHardLossCeiling(1, 0.5, 20); // -50% vs a 20% ceiling
    expect(result.breached).toBe(true);
    expect(result.pnlPercent).toBeCloseTo(-50);
  });

  it('does not breach when the loss is within the ceiling', () => {
    const result = evaluateHardLossCeiling(1, 0.9, 20); // -10% vs a 20% ceiling
    expect(result.breached).toBe(false);
    expect(result.pnlPercent).toBeCloseTo(-10);
  });

  it('breaches exactly at the boundary (uses <=, so exactly -20% does breach)', () => {
    expect(evaluateHardLossCeiling(100, 80, 20).breached).toBe(true); // exactly -20%
    expect(evaluateHardLossCeiling(100, 81, 20).breached).toBe(false); // -19%, just inside
  });

  it('never breaches on a gain', () => {
    const result = evaluateHardLossCeiling(1, 2, 20);
    expect(result.breached).toBe(false);
    expect(result.pnlPercent).toBeCloseTo(100);
  });

  it('never breaches from an unknown (zero/negative) entry price', () => {
    expect(evaluateHardLossCeiling(0, 0.000002, 20)).toEqual({ breached: false, pnlPercent: 0 });
    expect(evaluateHardLossCeiling(-1, 0.000002, 20)).toEqual({ breached: false, pnlPercent: 0 });
  });

  it('mirrors the real ANSEMCOIN incident: entry $0.0001915, crashed to $0.000002, 20% ceiling', () => {
    const result = evaluateHardLossCeiling(0.0001915, 0.000002, 20);
    expect(result.breached).toBe(true);
    expect(result.pnlPercent).toBeLessThan(-98);
  });
});

/**
 * 2026-07-21 audit (section G): a genuine, large market crash must never be
 * permanently misclassified as an "implausible outlier" and ignored forever —
 * these regression tests exercise the full combination of
 * isPlausiblePriceUpdate + reconcilePriceOutlier + evaluateHardLossCeiling
 * exactly as PriceMonitor composes them, for the two crash sizes explicitly
 * called out in the audit brief.
 */
describe('regression: legitimate large crashes are never ignored forever', () => {
  it('a 90% crash is within the single-tick plausibility band and is accepted immediately — no outlier handling needed at all', () => {
    // ratio = 0.1, well inside [1/20, 20] — ordinary single-tick move, not an outlier.
    expect(isPlausiblePriceUpdate(1, 0.1)).toBe(true);
    const hardLoss = evaluateHardLossCeiling(1, 0.1, 20);
    expect(hardLoss.breached).toBe(true); // -90% vs a 20% ceiling — stop loss must fire
  });

  it('a 99% crash is rejected as a single-tick outlier (ratio below the 20x band) but is force-closed immediately via the Hard-Loss-Ceiling fast path once a corroborating source agrees', () => {
    // ratio = 0.01, outside [1/20, 20] — correctly flagged as needing corroboration first.
    expect(isPlausiblePriceUpdate(1, 0.01)).toBe(false);

    const hardLoss = evaluateHardLossCeiling(1, 0.01, 20);
    expect(hardLoss.breached).toBe(true);

    // PriceMonitor's fast path probes an independent source before trusting the
    // crash — a second, independently-sourced quote agreeing is what turns a
    // rejected tick into a forced exit, not just the raw price reading alone.
    const reconciliation = reconcilePriceOutlier({
      candidatePriceUsd: 0.01,
      jupiterReverseQuotePriceUsd: 0.0095,
    });
    expect(reconciliation).toEqual({ accepted: true, source: 'jupiter_reverse_quote' });
  });

  it('a 99% crash with no corroborating source available is still never ignored forever — force-accepted once the sustained-rejection ceiling elapses', () => {
    expect(isPlausiblePriceUpdate(1, 0.01)).toBe(false);
    const reconciliation = reconcilePriceOutlier({
      candidatePriceUsd: 0.01,
      forcedAfterCeiling: true,
    });
    expect(reconciliation).toEqual({ accepted: true, source: 'forced_after_ceiling' });
  });

  it('a single bad quote (one implausible tick) is rejected without being force-accepted — only sustained/corroborated crashes are', () => {
    expect(isPlausiblePriceUpdate(1, 0.01)).toBe(false);
    const singleBadQuote = reconcilePriceOutlier({ candidatePriceUsd: 0.01 });
    expect(singleBadQuote.accepted).toBe(false);
  });

  it('multiple independent sources agreeing on the crash is stronger evidence than either alone, and both accept it', () => {
    const bothAgree = reconcilePriceOutlier({
      candidatePriceUsd: 0.01,
      jupiterReverseQuotePriceUsd: 0.0098,
      nativeDexReservesPriceUsd: 0.0102,
    });
    expect(bothAgree.accepted).toBe(true);
  });
});
