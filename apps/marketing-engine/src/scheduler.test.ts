import { describe, expect, it } from 'vitest';
import { planDailyPostTimes, remainingPostTimes } from './scheduler.js';

describe('planDailyPostTimes', () => {
  it('plans between 3 and 5 posts', () => {
    const dayStart = new Date('2026-01-01T00:00:00Z');
    for (let seed = 0; seed < 20; seed++) {
      let calls = 0;
      const random = () => {
        calls++;
        // First call decides the count; vary it across the test matrix.
        return calls === 1 ? seed / 20 : Math.random();
      };
      const times = planDailyPostTimes(dayStart, random);
      expect(times.length).toBeGreaterThanOrEqual(3);
      expect(times.length).toBeLessThanOrEqual(5);
    }
  });

  it('keeps all planned times within the target day', () => {
    const dayStart = new Date('2026-01-01T00:00:00Z');
    const dayEnd = new Date('2026-01-02T00:00:00Z');
    const times = planDailyPostTimes(dayStart);
    for (const t of times) {
      expect(t.getTime()).toBeGreaterThanOrEqual(dayStart.getTime());
      expect(t.getTime()).toBeLessThan(dayEnd.getTime());
    }
  });

  it('returns times sorted ascending', () => {
    const dayStart = new Date('2026-01-01T00:00:00Z');
    const times = planDailyPostTimes(dayStart);
    const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
    expect(times).toEqual(sorted);
  });

  it('spaces posts at least 45 minutes apart', () => {
    const dayStart = new Date('2026-01-01T00:00:00Z');
    const times = planDailyPostTimes(dayStart);
    for (let i = 1; i < times.length; i++) {
      const gapMs = times[i]!.getTime() - times[i - 1]!.getTime();
      expect(gapMs).toBeGreaterThanOrEqual(45 * 60 * 1000);
    }
  });
});

describe('remainingPostTimes', () => {
  it('filters out times at or before now', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const times = [
      new Date('2026-01-01T11:00:00Z'),
      new Date('2026-01-01T12:00:00Z'),
      new Date('2026-01-01T13:00:00Z'),
    ];
    expect(remainingPostTimes(times, now)).toEqual([new Date('2026-01-01T13:00:00Z')]);
  });
});
