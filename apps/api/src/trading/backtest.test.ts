import { describe, expect, it } from 'vitest';
import { runBacktest, runBacktestBatch } from './backtest.js';

describe('runBacktest', () => {
  it('exits at take profit candle', () => {
    const result = runBacktest(
      [
        { timestamp: 1, priceUsd: 1.1 },
        { timestamp: 2, priceUsd: 1.6 },
        { timestamp: 3, priceUsd: 1.2 },
      ],
      { entryPriceUsd: 1, amountSolInvested: 2, takeProfitPercent: 50 },
    );
    expect(result.exitReason).toBe('take_profit');
    expect(result.candlesHeld).toBe(2);
    expect(result.pnlSol).toBeGreaterThan(0);
  });

  it('falls through to end_of_data when no rule fires', () => {
    const result = runBacktest(
      [
        { timestamp: 1, priceUsd: 1.02 },
        { timestamp: 2, priceUsd: 1.03 },
      ],
      { entryPriceUsd: 1, amountSolInvested: 1, takeProfitPercent: 100, stopLossPercent: 90 },
    );
    expect(result.exitReason).toBe('end_of_data');
  });

  it('computes win rate across a batch', () => {
    const { winRate, results } = runBacktestBatch(
      [[{ timestamp: 1, priceUsd: 1.5 }], [{ timestamp: 1, priceUsd: 0.5 }]],
      { entryPriceUsd: 1, amountSolInvested: 1, takeProfitPercent: 40, stopLossPercent: 30 },
    );
    expect(results).toHaveLength(2);
    expect(winRate).toBe(0.5);
  });
});
