import { describe, expect, it } from 'vitest';
import { randomIntervalMs, pickNextFeedType, isDailyCapReached, utcDayKey } from './scheduler.js';
import { FEED_TYPES } from './data.js';

describe('randomIntervalMs', () => {
  it('stays within [min, max] across the rng range', () => {
    expect(randomIntervalMs(15, 120, () => 0)).toBe(15 * 60_000);
    expect(randomIntervalMs(15, 120, () => 0.999999)).toBeLessThan(120 * 60_000);
    expect(randomIntervalMs(15, 120, () => 0.5)).toBeGreaterThan(15 * 60_000);
  });

  it('returns the fixed value when min === max', () => {
    expect(randomIntervalMs(30, 30, () => 0.7)).toBe(30 * 60_000);
  });
});

describe('pickNextFeedType', () => {
  it('never picks a type with zero real backlog', () => {
    const chosen = pickNextFeedType(
      [
        { type: FEED_TYPES.NEW_OPPORTUNITY, count: 0 },
        { type: FEED_TYPES.WHALE_ALERT, count: 2 },
      ],
      undefined,
      () => 0,
    );
    expect(chosen).toBe(FEED_TYPES.WHALE_ALERT);
  });

  it('returns undefined when every feed type has zero backlog — never fabricates a pick', () => {
    const chosen = pickNextFeedType(
      [
        { type: FEED_TYPES.NEW_OPPORTUNITY, count: 0 },
        { type: FEED_TYPES.WHALE_ALERT, count: 0 },
      ],
      undefined,
      () => 0,
    );
    expect(chosen).toBeUndefined();
  });

  it('avoids repeating the immediately-previous type when another has backlog', () => {
    const chosen = pickNextFeedType(
      [
        { type: FEED_TYPES.NEW_OPPORTUNITY, count: 3 },
        { type: FEED_TYPES.WHALE_ALERT, count: 1 },
      ],
      FEED_TYPES.NEW_OPPORTUNITY,
      () => 0,
    );
    expect(chosen).toBe(FEED_TYPES.WHALE_ALERT);
  });

  it('allows repeating the previous type when it is the only one with backlog', () => {
    const chosen = pickNextFeedType(
      [
        { type: FEED_TYPES.NEW_OPPORTUNITY, count: 3 },
        { type: FEED_TYPES.WHALE_ALERT, count: 0 },
      ],
      FEED_TYPES.NEW_OPPORTUNITY,
      () => 0,
    );
    expect(chosen).toBe(FEED_TYPES.NEW_OPPORTUNITY);
  });
});

describe('isDailyCapReached', () => {
  it('is false below the cap and true at/above it', () => {
    expect(isDailyCapReached(19, 20)).toBe(false);
    expect(isDailyCapReached(20, 20)).toBe(true);
    expect(isDailyCapReached(21, 20)).toBe(true);
  });
});

describe('utcDayKey', () => {
  it('formats as an ISO date', () => {
    expect(utcDayKey(new Date('2026-07-27T23:59:00Z'))).toBe('2026-07-27');
  });
});
