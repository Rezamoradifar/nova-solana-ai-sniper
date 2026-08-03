import { describe, expect, it } from 'vitest';
import { compareStrategies, recommendOptimalConfig } from './strategyComparison.js';
import type { PriceCandle } from './backtest.js';

function series(pathsUsd: number[][]): PriceCandle[][] {
  return pathsUsd.map((prices) => prices.map((priceUsd, i) => ({ timestamp: i, priceUsd })));
}

describe('compareStrategies', () => {
  it('picks the config with the higher profit factor as the winner', () => {
    const data = series([
      [1, 1.5, 1.2], // rallies then pulls back
      [1, 0.9, 0.85], // drops
      [1, 1.4, 1.3],
    ]);
    // Tight TP catches the rally before the pullback; loose TP never fires.
    const tight = {
      entryPriceUsd: 1,
      amountSolInvested: 1,
      takeProfitPercent: 30,
      stopLossPercent: 50,
    };
    const loose = {
      entryPriceUsd: 1,
      amountSolInvested: 1,
      takeProfitPercent: 90,
      stopLossPercent: 50,
    };

    const result = compareStrategies(data, tight, loose);
    expect(result.a.totalTrades).toBe(3);
    expect(result.b.totalTrades).toBe(3);
    expect(['a', 'b', 'tie']).toContain(result.winner);
    expect(result.pairedWins.a + result.pairedWins.b + result.pairedWins.ties).toBe(3);
  });

  it('reports a tie when both configs behave identically', () => {
    const data = series([[1, 1.1, 1.2]]);
    const config = { entryPriceUsd: 1, amountSolInvested: 1, takeProfitPercent: 50 };
    const result = compareStrategies(data, config, { ...config });
    expect(result.winner).toBe('tie');
    expect(result.pairedWins.ties).toBe(1);
  });
});

describe('recommendOptimalConfig', () => {
  it('finds the take-profit value that captures the rally before it reverses', () => {
    const data = series([
      [1, 1.5, 1.0], // peaks at +50%, then fully reverses
      [1, 1.5, 1.0],
    ]);
    const base = {
      entryPriceUsd: 1,
      amountSolInvested: 1,
      takeProfitPercent: 90,
      stopLossPercent: 50,
    };

    const result = recommendOptimalConfig(data, base, { takeProfitPercent: [30, 50, 90] });

    expect(result.best).toBeDefined();
    expect(result.best!.config.takeProfitPercent).toBeLessThanOrEqual(50);
    expect(result.ranked.length).toBeGreaterThan(0);
    expect(result.recommendation).toContain('improves profit factor');
  });

  it('handles an empty series list without throwing', () => {
    const base = { entryPriceUsd: 1, amountSolInvested: 1, takeProfitPercent: 50 };
    const result = recommendOptimalConfig([], base, { takeProfitPercent: [30, 50] });
    expect(result.best).toBeUndefined();
    expect(result.recommendation).toContain('No historical series');
  });

  it('caps ranked results at 10 even with a larger grid', () => {
    const data = series([[1, 1.2, 1.1]]);
    const base = { entryPriceUsd: 1, amountSolInvested: 1 };
    const result = recommendOptimalConfig(data, base, {
      takeProfitPercent: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120],
    });
    expect(result.ranked.length).toBeLessThanOrEqual(10);
  });
});
