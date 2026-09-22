import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient, User } from '@prisma/client';
import { renderLanguage, applyLanguage } from './language.js';
import { renderHome } from './home.js';
import type { ScreenDeps } from '../types.js';

function fakeDeps(overrides: Partial<{ update: ReturnType<typeof vi.fn> }> = {}): ScreenDeps {
  const prisma = {
    wallet: { count: vi.fn().mockResolvedValue(0) },
    snipeConfig: { count: vi.fn().mockResolvedValue(0) },
    position: { count: vi.fn().mockResolvedValue(0) },
    user: {
      update:
        overrides.update ??
        vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...user, ...data })),
    },
  } as unknown as PrismaClient;
  return {
    prisma,
    encryptionKey: 'key',
    logger: { error: vi.fn() } as never,
    telegramTrend: {
      enabled: false,
      channels: [],
      minAiScore: 50,
      pollIntervalMs: 20000,
      metricsUrl: '',
    },
  };
}

const user = { id: 'user-1', language: 'en' } as User;

describe('renderLanguage', () => {
  it('shows both language options with nav back to Settings', async () => {
    const result = await renderLanguage(fakeDeps(), user);
    expect(result.text).toContain('Language');
    const labels = result.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('🇬🇧 English');
    expect(labels).toContain('🇮🇷 فارسی');
  });
});

describe('applyLanguage', () => {
  it('persists a recognized language code', async () => {
    const update = vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...user, ...data }));
    const updated = await applyLanguage(fakeDeps({ update }), user, 'fa');
    expect(update).toHaveBeenCalledWith({ where: { id: user.id }, data: { language: 'fa' } });
    expect(updated.language).toBe('fa');
  });

  it('falls back to "en" for an unrecognized value rather than writing garbage', async () => {
    const update = vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...user, ...data }));
    const updated = await applyLanguage(fakeDeps({ update }), user, 'not-a-locale');
    expect(update).toHaveBeenCalledWith({ where: { id: user.id }, data: { language: 'en' } });
    expect(updated.language).toBe('en');
  });
});

describe('renderHome in Persian', () => {
  it('renders Persian copy end-to-end when user.language is "fa"', async () => {
    const result = await renderHome(fakeDeps(), { ...user, language: 'fa' } as User);
    expect(result.text).toContain('👋 *GSP Bank Sniper*');
    expect(result.text).toContain('بدون سطح‌بندی');
    const labels = result.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('👛 کیف پول');
  });
});
