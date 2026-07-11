import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient, User } from '@prisma/client';
import { MAX_SNIPE_CONFIGS_PER_USER } from '@nova/shared';
import { handleQuickStart, renderSniperStart } from './sniper.js';
import type { ScreenDeps } from '../types.js';

function makeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    buyAmountSol: 0.1,
    isActive: true,
    autoBuyOnLaunch: true,
    minAiScore: 60,
    ...overrides,
  };
}

function fakeDeps(configs: ReturnType<typeof makeConfig>[]) {
  const create = vi.fn().mockResolvedValue(undefined);
  const count = vi.fn().mockResolvedValue(configs.length);
  const findMany = vi.fn().mockResolvedValue(configs);
  const businessSettingsFindFirst = vi.fn().mockResolvedValue({
    id: 'settings-1',
    performanceFeeBps: 2000,
    referralProgramEnabled: true,
    maxReferralDepth: 2,
    referralLevels: [],
  });
  const prisma = {
    snipeConfig: { create, count, findMany },
    businessSettings: { findFirst: businessSettingsFindFirst, create: vi.fn() },
  } as unknown as PrismaClient;
  const deps = {
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
  } as ScreenDeps;
  return { deps, create, count, findMany };
}

// Fee policy already accepted at the current fee %, so these existing tests
// exercise the screen's normal (post-consent-gate) behavior unchanged.
const user = {
  id: 'user-1',
  feePolicyAcceptedAt: new Date(),
  feePolicyAcceptedFeeBps: 2000,
} as User;

describe('renderSniperStart', () => {
  it("regression: never builds a message over Telegram's 4096-char limit, however many configs exist", async () => {
    // Live-verified failure: a user who repeatedly tapped "Add Another Config"
    // before the cap existed ended up with 75 duplicate rows, and every line
    // pushed the rendered text past Telegram's 4096-char sendMessage limit —
    // GrammyError 400 "message is too long", permanently breaking this screen.
    const configs = Array.from({ length: 75 }, () => makeConfig());
    const { deps } = fakeDeps(configs);
    const result = await renderSniperStart(deps, user);
    expect(result.text.length).toBeLessThan(4096);
    expect(result.text).toContain('more (contact support');
  });

  it('hides the Add Another Config button once at the per-user cap', async () => {
    const configs = Array.from({ length: MAX_SNIPE_CONFIGS_PER_USER }, () => makeConfig());
    const { deps } = fakeDeps(configs);
    const result = await renderSniperStart(deps, user);
    const buttons = result.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(buttons).not.toContain('➕ Add Another Config (0.1 SOL)');
  });
});

describe('handleQuickStart', () => {
  it('regression: refuses to create another config once the user is at the cap', async () => {
    const configs = Array.from({ length: MAX_SNIPE_CONFIGS_PER_USER }, () => makeConfig());
    const { deps, create } = fakeDeps(configs);
    await handleQuickStart(deps, user);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a config when under the cap', async () => {
    const { deps, create } = fakeDeps([makeConfig()]);
    await handleQuickStart(deps, user);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('fee policy consent gate', () => {
  const unacceptedUser = {
    id: 'user-2',
    feePolicyAcceptedAt: null,
    feePolicyAcceptedFeeBps: null,
  } as User;

  it('renderSniperStart shows the consent screen instead of configs when not yet accepted', async () => {
    const { deps } = fakeDeps([makeConfig()]);
    const result = await renderSniperStart(deps, unacceptedUser);
    expect(result.text).toContain('Performance Fee & Referral Policy');
    const buttons = result.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(buttons).toContain('✅ I Agree, Enable Auto-Trading');
  });

  it('handleQuickStart refuses to create a config when the policy has not been accepted', async () => {
    const { deps, create } = fakeDeps([]);
    const result = await handleQuickStart(deps, unacceptedUser);
    expect(create).not.toHaveBeenCalled();
    expect(result.text).toContain('Performance Fee & Referral Policy');
  });

  it('re-prompts when the accepted fee % is stale (an admin changed it since acceptance)', async () => {
    const staleUser = {
      id: 'user-3',
      feePolicyAcceptedAt: new Date(),
      feePolicyAcceptedFeeBps: 1500,
    } as User;
    const { deps, create } = fakeDeps([]);
    const result = await handleQuickStart(deps, staleUser);
    expect(create).not.toHaveBeenCalled();
    expect(result.text).toContain('Performance Fee & Referral Policy');
  });
});
