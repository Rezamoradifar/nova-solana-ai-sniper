import { describe, expect, it, vi } from 'vitest';
import { RedisDailyTradeCardLimiter, tehranDay } from './dailyLimit.js';

describe('daily trade card quota', () => {
  it('changes day at Tehran midnight, not UTC midnight', () => {
    expect(tehranDay(new Date('2026-10-03T20:29:59Z'))).toBe('2026-10-03');
    expect(tehranDay(new Date('2026-10-03T20:30:00Z'))).toBe('2026-10-04');
  });
  it('uses the same persistent quota key across restarts and rolls over next day', async () => {
    const evalFn = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    const redis = { eval: evalFn };
    const before = () => new Date('2026-10-03T20:29:59Z');
    expect(await new RedisDailyTradeCardLimiter(redis, 10, before).reserve('pos1')).toBe(true);
    expect(await new RedisDailyTradeCardLimiter(redis, 10, before).reserve('pos1')).toBe(false);
    expect(
      await new RedisDailyTradeCardLimiter(
        redis,
        10,
        () => new Date('2026-10-03T20:30:00Z'),
      ).reserve('pos2'),
    ).toBe(true);
    expect(evalFn.mock.calls[0]!.slice(1)).toEqual([
      1,
      'nova:telegram:daily-trade-cards:2026-10-03',
      'pos1',
      10,
    ]);
    expect(evalFn.mock.calls[1]![2]).toBe(evalFn.mock.calls[0]![2]);
    expect(evalFn.mock.calls[2]![2]).toBe('nova:telegram:daily-trade-cards:2026-10-04');
  });
});
