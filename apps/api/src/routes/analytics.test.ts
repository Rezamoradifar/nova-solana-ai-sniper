import { describe, expect, it } from 'vitest';
import { toTradeOutcome } from './analytics.js';

describe('toTradeOutcome', () => {
  it("derives pnlPercent from realizedPnlUsd against the position's original USD cost basis", () => {
    const outcome = toTradeOutcome({ realizedPnlUsd: 5, amountToken: 100, entryPriceUsd: 0.1 });
    // costBasis = 100 * 0.1 = 10; pnlPercent = 5/10*100 = 50
    expect(outcome.costBasisUsd).toBeCloseTo(10);
    expect(outcome.pnlPercent).toBeCloseTo(50);
    expect(outcome.pnlAmount).toBe(5);
  });

  it('treats a null realizedPnlUsd as 0 pnl rather than throwing', () => {
    const outcome = toTradeOutcome({ realizedPnlUsd: null, amountToken: 100, entryPriceUsd: 0.1 });
    expect(outcome.pnlAmount).toBe(0);
    expect(outcome.pnlPercent).toBe(0);
  });

  it('is 0 pnlPercent (not Infinity/NaN) when cost basis is 0', () => {
    const outcome = toTradeOutcome({ realizedPnlUsd: 5, amountToken: 0, entryPriceUsd: 0.1 });
    expect(outcome.pnlPercent).toBe(0);
  });
});
