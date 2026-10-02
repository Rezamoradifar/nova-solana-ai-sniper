import { describe, expect, it } from 'vitest';
import {
  capBuyAmountForPlan,
  computePlanExpiry,
  effectivePlanKey,
  planBlocksAutoBuy,
  planFeeBps,
} from './plans.js';

const NOW = new Date('2026-10-02T00:00:00Z');
const DAY = 86_400_000;

describe('plans', () => {
  it('falls back to free once a paid plan expires', () => {
    expect(
      effectivePlanKey({ planKey: 'pro', planExpiresAt: new Date(NOW.getTime() + DAY) }, NOW),
    ).toBe('pro');
    expect(
      effectivePlanKey({ planKey: 'pro', planExpiresAt: new Date(NOW.getTime() - 1) }, NOW),
    ).toBe('free');
    expect(effectivePlanKey({ planKey: 'pro', planExpiresAt: null }, NOW)).toBe('free');
  });

  it('extends a still-active renewal, otherwise starts now', () => {
    const exp = new Date(NOW.getTime() + 10 * DAY);
    expect(
      computePlanExpiry({ planKey: 'pro', planExpiresAt: exp }, 'pro', 30, NOW).expiresAt.getTime(),
    ).toBe(exp.getTime() + 30 * DAY);
    expect(
      computePlanExpiry({ planKey: 'pro', planExpiresAt: exp }, 'elite', 30, NOW).startsAt,
    ).toEqual(NOW);
    expect(
      computePlanExpiry(
        { planKey: 'free', planExpiresAt: null },
        'pro',
        30,
        NOW,
      ).expiresAt.getTime(),
    ).toBe(NOW.getTime() + 30 * DAY);
  });

  it('caps the buy size and open positions', () => {
    expect(capBuyAmountForPlan(5, { maxBuySol: 2 })).toBe(2);
    expect(capBuyAmountForPlan(1, { maxBuySol: null })).toBe(1);
    expect(planBlocksAutoBuy({ autoBuyEnabled: true, maxOpenPositions: 2 }, 2)).toMatch(/max_open/);
    expect(planBlocksAutoBuy({ autoBuyEnabled: true, maxOpenPositions: null }, 99)).toBeUndefined();
    expect(planBlocksAutoBuy({ autoBuyEnabled: false, maxOpenPositions: null }, 0)).toBe(
      'plan_auto_buy_disabled',
    );
  });

  it('uses the plan fee when set, else the global fee', () => {
    expect(planFeeBps({ feeBps: 1000 }, 2000)).toBe(1000);
    expect(planFeeBps({ feeBps: null }, 2000)).toBe(2000);
    expect(planFeeBps(undefined, 2000)).toBe(2000);
  });
});
