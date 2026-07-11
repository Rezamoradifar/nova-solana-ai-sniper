import { describe, expect, it } from 'vitest';
import { evaluateExit } from './exitEngine.js';
import {
  computeAdaptiveTrailingStopPercent,
  computeTrailingStopDisplay,
  resolvePresetExitParams,
  stopLossPercentForPreset,
  TRAILING_STOP_PRESETS,
} from './adaptiveTrailingStop.js';

describe('computeAdaptiveTrailingStopPercent', () => {
  it("uses each preset's base distance for mid-range liquidity/concentration", () => {
    expect(
      computeAdaptiveTrailingStopPercent('conservative', {
        liquidityUsd: 50_000,
        top10HolderPercent: 40,
      }),
    ).toBe(8);
    expect(
      computeAdaptiveTrailingStopPercent('balanced', {
        liquidityUsd: 50_000,
        top10HolderPercent: 40,
      }),
    ).toBe(15);
    expect(
      computeAdaptiveTrailingStopPercent('aggressive', {
        liquidityUsd: 50_000,
        top10HolderPercent: 40,
      }),
    ).toBe(25);
    expect(
      computeAdaptiveTrailingStopPercent('meme_coin', {
        liquidityUsd: 50_000,
        top10HolderPercent: 40,
      }),
    ).toBe(30);
  });

  it('widens the trail for deep liquidity + low concentration', () => {
    const wide = computeAdaptiveTrailingStopPercent('balanced', {
      liquidityUsd: 200_000,
      top10HolderPercent: 10,
    });
    expect(wide).toBe(15 + 3 + 2); // 20
  });

  it('tightens the trail for thin liquidity + high concentration', () => {
    const tight = computeAdaptiveTrailingStopPercent('balanced', {
      liquidityUsd: 5_000,
      top10HolderPercent: 80,
    });
    expect(tight).toBe(15 - 3 - 3); // 9
  });

  it('never goes below the floor or above the ceiling regardless of inputs', () => {
    const extremeLow = computeAdaptiveTrailingStopPercent('conservative', {
      liquidityUsd: 0,
      top10HolderPercent: 100,
    });
    expect(extremeLow).toBeGreaterThanOrEqual(3);

    const extremeHigh = computeAdaptiveTrailingStopPercent('meme_coin', {
      liquidityUsd: 10_000_000,
      top10HolderPercent: 0,
    });
    expect(extremeHigh).toBeLessThanOrEqual(50);
  });
});

describe('resolvePresetExitParams', () => {
  it('never sets a take-profit cap, for every preset', () => {
    for (const preset of TRAILING_STOP_PRESETS) {
      const params = resolvePresetExitParams(preset, {
        liquidityUsd: 50_000,
        top10HolderPercent: 40,
      });
      expect(params.takeProfitPercent).toBeUndefined();
    }
  });

  it("applies the preset's stop-loss floor", () => {
    expect(stopLossPercentForPreset('conservative')).toBe(15);
    expect(stopLossPercentForPreset('meme_coin')).toBe(40);
  });
});

describe('computeTrailingStopDisplay', () => {
  it('computes locked profit and distance-to-stop consistent with the trailing-stop price formula', () => {
    const display = computeTrailingStopDisplay({
      entryPriceUsd: 100,
      currentPriceUsd: 200,
      highWaterMarkUsd: 200,
      amountToken: 1_000_000,
      tokenDecimals: 6,
      trailingStopPercent: 15,
    });
    expect(display.athUsd).toBe(200);
    expect(display.currentProfitPercent).toBe(100); // +100%
    expect(display.currentProfitUsd).toBe(100); // (200-100) * 1 real token
    expect(display.trailingStopPriceUsd).toBeCloseTo(170); // 200 * 0.85
    expect(display.lockedProfitPercent).toBeCloseTo(70); // (170-100)/100*100
    expect(display.distanceToStopPercent).toBeCloseTo(15); // (200-170)/200*100
  });

  it('leaves stop-related fields undefined when no trailing stop is configured', () => {
    const display = computeTrailingStopDisplay({
      entryPriceUsd: 100,
      currentPriceUsd: 150,
      highWaterMarkUsd: 150,
      amountToken: 1_000_000,
      tokenDecimals: 6,
      trailingStopPercent: null,
    });
    expect(display.trailingStopPriceUsd).toBeUndefined();
    expect(display.lockedProfitPercent).toBeUndefined();
    expect(display.distanceToStopPercent).toBeUndefined();
  });
});

/**
 * The requirement-#8 simulation suite. Runs against the real, UNMODIFIED
 * evaluateExit (exitEngine.ts) — not a reimplementation — because the whole
 * point is proving the exact function that runs in production already behaves
 * correctly once takeProfitPercent is left unset and a trailing % is supplied.
 */
describe('Meme Coin Mode simulation: entry $100, climbing through +25% .. +10000%', () => {
  const ENTRY = 100;
  const TRAILING_PERCENT = 30; // meme_coin preset base

  // Each step is a new all-time-high; none should trigger an exit while still climbing.
  const climbPath = [
    { label: '+25%', price: 125 },
    { label: '+50%', price: 150 },
    { label: '+100%', price: 200 },
    { label: '+300%', price: 400 },
    { label: '+500%', price: 600 },
    { label: '+1000%', price: 1100 },
    { label: '+5000%', price: 5100 },
    { label: '+10000%', price: 10100 },
  ];

  it('never exits on the way up, and the high-water mark only ever increases', () => {
    let highWaterMarkUsd = ENTRY;
    for (const step of climbPath) {
      const decision = evaluateExit({
        entryPriceUsd: ENTRY,
        currentPriceUsd: step.price,
        highWaterMarkUsd,
        takeProfitPercent: undefined, // no cap — requirement #1
        stopLossPercent: 40,
        trailingStopPercent: TRAILING_PERCENT,
      });

      expect(decision.shouldExit).toBe(false);
      expect(decision.newHighWaterMarkUsd).toBeGreaterThanOrEqual(highWaterMarkUsd);
      expect(decision.newHighWaterMarkUsd).toBe(step.price); // each step IS the new ATH
      highWaterMarkUsd = decision.newHighWaterMarkUsd;
    }
    // Reached the full +10000% with nothing capping it early.
    expect(decision(highWaterMarkUsd).pnlPercent).toBeCloseTo(10000); // (10100-100)/100*100
  });

  function decision(highWaterMarkUsd: number) {
    return evaluateExit({
      entryPriceUsd: ENTRY,
      currentPriceUsd: highWaterMarkUsd,
      highWaterMarkUsd,
      takeProfitPercent: undefined,
      stopLossPercent: 40,
      trailingStopPercent: TRAILING_PERCENT,
    });
  }

  it('a small dip that stays inside the trailing distance does not exit, and the ATH is preserved (never moves down)', () => {
    const afterPeak = evaluateExit({
      entryPriceUsd: ENTRY,
      currentPriceUsd: 9000, // down from ATH 10100, but only ~10.9% off — inside the 30% trail
      highWaterMarkUsd: 10100,
      takeProfitPercent: undefined,
      stopLossPercent: 40,
      trailingStopPercent: TRAILING_PERCENT,
    });
    expect(afterPeak.shouldExit).toBe(false);
    // ATH must stay at the prior peak, not fall to the dipped price.
    expect(afterPeak.newHighWaterMarkUsd).toBe(10100);
  });

  it('exits via trailing_stop once price drops by exactly the configured % off the ATH, protecting the vast majority of the gain', () => {
    const athUsd = 10100;
    const stopPriceUsd = athUsd * (1 - TRAILING_PERCENT / 100); // 7070
    const atStop = evaluateExit({
      entryPriceUsd: ENTRY,
      currentPriceUsd: stopPriceUsd,
      highWaterMarkUsd: athUsd,
      takeProfitPercent: undefined,
      stopLossPercent: 40,
      trailingStopPercent: TRAILING_PERCENT,
    });

    expect(atStop.shouldExit).toBe(true);
    expect(atStop.reason).toBe('trailing_stop');
    // Never allow a trade that reached a large profit to become a loss: locked-in
    // PnL at the stop is still deeply positive (thousands of percent), not negative.
    expect(atStop.pnlPercent).toBeGreaterThan(6900); // (7070-100)/100*100 = 6970%
  });

  it('the ATH never decreases across an arbitrary noisy path, even with repeated small pullbacks', () => {
    const path = [110, 105, 130, 120, 200, 180, 190, 500, 480, 495];
    let highWaterMarkUsd = ENTRY;
    let priorHwm = ENTRY;
    for (const price of path) {
      const d = evaluateExit({
        entryPriceUsd: ENTRY,
        currentPriceUsd: price,
        highWaterMarkUsd,
        takeProfitPercent: undefined,
        stopLossPercent: 90, // wide enough that only trailing-stop logic is exercised here
        trailingStopPercent: TRAILING_PERCENT,
      });
      expect(d.newHighWaterMarkUsd).toBeGreaterThanOrEqual(priorHwm);
      priorHwm = d.newHighWaterMarkUsd;
      highWaterMarkUsd = d.newHighWaterMarkUsd;
    }
    expect(highWaterMarkUsd).toBe(500); // the true max of the path, never regressed
  });
});
