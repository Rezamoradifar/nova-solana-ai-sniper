import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from './ttlCache.js';

describe('TtlCache', () => {
  it('reports a key as not present before it is added', () => {
    const cache = new TtlCache<string>(1000);
    expect(cache.has('mint1')).toBe(false);
  });

  it('reports a key as present immediately after adding it', () => {
    const cache = new TtlCache<string>(1000);
    cache.add('mint1');
    expect(cache.has('mint1')).toBe(true);
  });

  it('expires a key once its TTL elapses', () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<string>(1000);
      cache.add('mint1');
      vi.advanceTimersByTime(1001);
      expect(cache.has('mint1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sweeps expired entries once the size threshold is reached on insert', () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<number>(1000, 2);
      cache.add(1);
      cache.add(2);
      vi.advanceTimersByTime(1001);
      // Crossing the sweep threshold on this insert should evict 1 and 2 (expired),
      // leaving only 3 behind.
      cache.add(3);
      expect(cache.size).toBe(1);
      expect(cache.has(3)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
