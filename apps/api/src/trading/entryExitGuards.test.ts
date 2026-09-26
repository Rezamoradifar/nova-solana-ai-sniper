import { describe, expect, it } from 'vitest';
import { buyPriceImpactTooHigh, shouldTimeStop } from './entryExitGuards.js';

describe('buyPriceImpactTooHigh', () => {
  it('converts Jupiter fraction to percent and compares against the limit', () => {
    expect(buyPriceImpactTooHigh('0.08', 5)).toEqual({ tooHigh: true, impactPercent: 8 });
    expect(buyPriceImpactTooHigh('0.012', 5)).toEqual({ tooHigh: false, impactPercent: 1.2 });
  });
  it('is disabled at 0 and ignores missing quotes', () => {
    expect(buyPriceImpactTooHigh('0.9', 0).tooHigh).toBe(false);
    expect(buyPriceImpactTooHigh(undefined, 5).tooHigh).toBe(false);
  });
});

describe('shouldTimeStop', () => {
  const openedAt = new Date('2026-09-26T10:00:00Z');
  const guards = { timeStopMinutes: 15, timeStopMinProfitPercent: 10 };
  const base = { openedAt, entryPriceUsd: 1, takeProfitStageReached: false };

  it('fires after the time limit when profit is below the minimum', () => {
    expect(
      shouldTimeStop(
        { ...base, now: new Date('2026-09-26T10:16:00Z'), currentPriceUsd: 1.05 },
        guards,
      ),
    ).toBe(true);
  });
  it('does not fire before the time limit', () => {
    expect(
      shouldTimeStop(
        { ...base, now: new Date('2026-09-26T10:10:00Z'), currentPriceUsd: 0.9 },
        guards,
      ),
    ).toBe(false);
  });
  it('does not fire when the position is already in profit above the minimum', () => {
    expect(
      shouldTimeStop(
        { ...base, now: new Date('2026-09-26T10:30:00Z'), currentPriceUsd: 1.2 },
        guards,
      ),
    ).toBe(false);
  });
  it('never fires once the take-profit stage has been reached', () => {
    expect(
      shouldTimeStop(
        {
          ...base,
          takeProfitStageReached: true,
          now: new Date('2026-09-26T11:00:00Z'),
          currentPriceUsd: 1,
        },
        guards,
      ),
    ).toBe(false);
  });
  it('is disabled at 0 minutes', () => {
    expect(
      shouldTimeStop(
        { ...base, now: new Date('2026-09-26T12:00:00Z'), currentPriceUsd: 0.5 },
        { ...guards, timeStopMinutes: 0 },
      ),
    ).toBe(false);
  });
});
