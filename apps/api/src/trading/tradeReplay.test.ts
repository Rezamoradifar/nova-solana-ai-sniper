import { describe, expect, it } from 'vitest';
import { replayTrade, analyzeMissedProfit } from './tradeReplay.js';

describe('replayTrade', () => {
  it('produces one step per evaluated candle and stops at the exit candle', () => {
    const candles = [
      { timestamp: 1, priceUsd: 1.1 },
      { timestamp: 2, priceUsd: 1.6 },
      { timestamp: 3, priceUsd: 1.2 },
    ];
    const result = replayTrade(candles, {
      entryPriceUsd: 1,
      amountSolInvested: 1,
      takeProfitPercent: 50,
    });

    expect(result.exitReason).toBe('take_profit');
    expect(result.exitIndex).toBe(1);
    expect(result.steps).toHaveLength(2); // stops at the exit candle, doesn't evaluate candle 3
    expect(result.steps[1]!.shouldExit).toBe(true);
    expect(result.steps[0]!.shouldExit).toBe(false);
  });

  it('falls through to end_of_data and still returns a step for every candle', () => {
    const candles = [
      { timestamp: 1, priceUsd: 1.01 },
      { timestamp: 2, priceUsd: 1.02 },
    ];
    const result = replayTrade(candles, {
      entryPriceUsd: 1,
      amountSolInvested: 1,
      takeProfitPercent: 100,
      stopLossPercent: 90,
    });

    expect(result.exitReason).toBe('end_of_data');
    expect(result.exitIndex).toBe(1);
    expect(result.steps).toHaveLength(2);
  });

  it('tracks a rising high-water mark across steps', () => {
    const candles = [
      { timestamp: 1, priceUsd: 1.2 },
      { timestamp: 2, priceUsd: 1.5 },
      { timestamp: 3, priceUsd: 1.3 },
    ];
    const result = replayTrade(candles, {
      entryPriceUsd: 1,
      amountSolInvested: 1,
      trailingStopPercent: 90,
    });
    expect(result.steps[0]!.highWaterMarkUsd).toBeCloseTo(1.2);
    expect(result.steps[1]!.highWaterMarkUsd).toBeCloseTo(1.5);
    expect(result.steps[2]!.highWaterMarkUsd).toBeCloseTo(1.5);
  });
});

describe('analyzeMissedProfit', () => {
  it('finds upside left on the table after an early take-profit exit', () => {
    const candles = [
      { timestamp: 1, priceUsd: 1.5 }, // exits here at +50% TP
      { timestamp: 2, priceUsd: 1.8 },
      { timestamp: 3, priceUsd: 2.0 }, // real peak
      { timestamp: 4, priceUsd: 1.7 },
    ];
    const result = analyzeMissedProfit(candles, {
      entryPriceUsd: 1,
      amountSolInvested: 1,
      takeProfitPercent: 50,
    });

    expect(result.peakPriceAfterExitUsd).toBeCloseTo(2.0);
    expect(result.peakIndex).toBe(2);
    // (2.0 - 1.5) / 1.5 * 100
    expect(result.missedProfitPercent).toBeCloseTo(33.33, 1);
  });

  it('is 0 when the exit candle is the last candle in the series', () => {
    const candles = [{ timestamp: 1, priceUsd: 1.5 }];
    const result = analyzeMissedProfit(candles, {
      entryPriceUsd: 1,
      amountSolInvested: 1,
      takeProfitPercent: 50,
    });
    expect(result.peakPriceAfterExitUsd).toBeUndefined();
    expect(result.missedProfitPercent).toBe(0);
  });

  it('is 0 when nothing after the exit ever exceeds the exit price', () => {
    const candles = [
      { timestamp: 1, priceUsd: 1.5 },
      { timestamp: 2, priceUsd: 1.3 },
      { timestamp: 3, priceUsd: 1.1 },
    ];
    const result = analyzeMissedProfit(candles, {
      entryPriceUsd: 1,
      amountSolInvested: 1,
      takeProfitPercent: 50,
    });
    expect(result.missedProfitPercent).toBe(0);
  });
});
