import { describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import type { Redis } from 'ioredis';
import { renderTrendSettings, handleToggleTrendMonitor } from './trendSettings.js';
import type { ScreenDeps } from '../types.js';

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

function fakeDeps(overrides: Partial<ScreenDeps> = {}): ScreenDeps {
  return {
    prisma: {} as never,
    encryptionKey: 'key',
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
    telegramTrend: {
      enabled: true,
      channels: ['trendingssol', 'trending'],
      minAiScore: 50,
      pollIntervalMs: 20000,
      metricsUrl: '',
    },
    adminIds: new Set(['ADMIN_1']),
    redis: fakeRedis(),
    ...overrides,
  };
}

const admin = { id: 'user-admin', telegramId: 'ADMIN_1', language: 'en' } as User;
const regular = { id: 'user-1', telegramId: 'REGULAR_1', language: 'en' } as User;

describe('renderTrendSettings', () => {
  it('shows a Pause button to an admin when the monitor is env-enabled and not paused', async () => {
    const result = await renderTrendSettings(fakeDeps(), admin);
    expect(result.text).toContain('Enabled');
    const labels = result.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('⏸ Pause Trend Monitor');
  });

  it('shows no toggle button to a non-admin', async () => {
    const result = await renderTrendSettings(fakeDeps(), regular);
    const labels = result.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).not.toContain('⏸ Pause Trend Monitor');
    expect(labels).not.toContain('▶️ Resume Trend Monitor');
  });

  it('shows a Resume button and "Paused" status once an admin has paused it via Redis', async () => {
    const redis = fakeRedis('0');
    const result = await renderTrendSettings(fakeDeps({ redis }), admin);
    expect(result.text).toContain('Paused (admin)');
    const labels = result.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('▶️ Resume Trend Monitor');
  });

  it('shows "Disabled" with no toggle button at all when TELEGRAM_TREND_SOURCE_ENABLED is off (needs a restart)', async () => {
    const result = await renderTrendSettings(
      fakeDeps({
        telegramTrend: {
          enabled: false,
          channels: [],
          minAiScore: 50,
          pollIntervalMs: 20000,
          metricsUrl: '',
        },
      }),
      admin,
    );
    expect(result.text).toContain('Disabled');
    expect(result.text).toContain('restart nova-api');
    const labels = result.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).not.toContain('⏸ Pause Trend Monitor');
  });

  it('falls back to the env snapshot (no live pause) when deps.redis is not wired up', async () => {
    const result = await renderTrendSettings(fakeDeps({ redis: undefined }), admin);
    expect(result.text).toContain('Enabled');
    const labels = result.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).not.toContain('⏸ Pause Trend Monitor');
  });
});

describe('handleToggleTrendMonitor', () => {
  it('pauses the monitor when an admin taps toggle while it is running', async () => {
    const redis = fakeRedis();
    const deps = fakeDeps({ redis });

    const result = await handleToggleTrendMonitor(deps, admin);

    expect(redis.set).toHaveBeenCalledWith('nova:telegram_trend:enabled', '0');
    expect(result.text).toContain('Paused (admin)');
  });

  it('resumes the monitor when an admin taps toggle while it is paused', async () => {
    const redis = fakeRedis('0');
    const deps = fakeDeps({ redis });

    const result = await handleToggleTrendMonitor(deps, admin);

    expect(redis.set).toHaveBeenCalledWith('nova:telegram_trend:enabled', '1');
    expect(result.text).toContain('Enabled');
  });

  it('is a silent no-op for a non-admin — never trusts callback_data alone', async () => {
    const redis = fakeRedis();
    const deps = fakeDeps({ redis });

    await handleToggleTrendMonitor(deps, regular);

    expect(redis.set).not.toHaveBeenCalled();
  });
});
