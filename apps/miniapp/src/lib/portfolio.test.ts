import { describe, expect, it } from 'vitest';
import { aggregatePortfolio } from './portfolio.js';

describe('aggregatePortfolio', () => {
  it('sums across multiple wallets — GET /portfolio is one entry per wallet, not a single object', () => {
    const result = aggregatePortfolio([
      {
        walletId: 'w1',
        openPositions: 2,
        totalInvestedSol: 1,
        realizedPnlUsd: 10,
        unrealizedPnlUsd: 5,
      },
      {
        walletId: 'w2',
        openPositions: 1,
        totalInvestedSol: 2,
        realizedPnlUsd: -3,
        unrealizedPnlUsd: 1,
      },
    ]);
    expect(result).toEqual({
      walletId: 'all',
      openPositions: 3,
      totalInvestedSol: 3,
      realizedPnlUsd: 7,
      unrealizedPnlUsd: 6,
    });
  });

  it('returns all zeros for an empty wallet list, not undefined/NaN', () => {
    expect(aggregatePortfolio([])).toEqual({
      walletId: 'all',
      openPositions: 0,
      totalInvestedSol: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
    });
  });

  it('treats a non-finite field on one wallet as 0 rather than poisoning the whole sum with NaN', () => {
    const result = aggregatePortfolio([
      {
        walletId: 'w1',
        openPositions: 1,
        totalInvestedSol: 1,
        realizedPnlUsd: NaN,
        unrealizedPnlUsd: 5,
      },
      {
        walletId: 'w2',
        openPositions: 1,
        totalInvestedSol: 1,
        realizedPnlUsd: 10,
        unrealizedPnlUsd: 1,
      },
    ]);
    expect(result.realizedPnlUsd).toBe(10);
    expect(Number.isFinite(result.realizedPnlUsd)).toBe(true);
  });
});
