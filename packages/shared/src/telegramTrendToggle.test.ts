import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  TELEGRAM_TREND_ENABLED_REDIS_KEY,
  getTelegramTrendEnabled,
  setTelegramTrendEnabled,
} from './telegramTrendToggle.js';

function fakeRedis(initial: string | null = null) {
  let stored = initial;
  return {
    get: vi.fn().mockImplementation(() => Promise.resolve(stored)),
    set: vi.fn().mockImplementation((_key: string, value: string) => {
      stored = value;
      return Promise.resolve('OK');
    }),
  } as unknown as Redis;
}

describe('getTelegramTrendEnabled', () => {
  it('defaults to enabled when the key was never set', async () => {
    const redis = fakeRedis(null);
    expect(await getTelegramTrendEnabled(redis)).toBe(true);
  });

  it('is disabled only when explicitly set to "0"', async () => {
    const redis = fakeRedis('0');
    expect(await getTelegramTrendEnabled(redis)).toBe(false);
  });

  it('is enabled when explicitly set to "1"', async () => {
    const redis = fakeRedis('1');
    expect(await getTelegramTrendEnabled(redis)).toBe(true);
  });
});

describe('setTelegramTrendEnabled', () => {
  it('round-trips true/false through the same redis key', async () => {
    const redis = fakeRedis();
    await setTelegramTrendEnabled(redis, false);
    expect(redis.set).toHaveBeenCalledWith(TELEGRAM_TREND_ENABLED_REDIS_KEY, '0');
    expect(await getTelegramTrendEnabled(redis)).toBe(false);

    await setTelegramTrendEnabled(redis, true);
    expect(redis.set).toHaveBeenCalledWith(TELEGRAM_TREND_ENABLED_REDIS_KEY, '1');
    expect(await getTelegramTrendEnabled(redis)).toBe(true);
  });
});
