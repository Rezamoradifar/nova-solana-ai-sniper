import { describe, expect, it } from 'vitest';
import { evaluateExit } from './exitEngine.js';

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
