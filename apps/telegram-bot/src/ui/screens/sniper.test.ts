import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient, User } from '@prisma/client';
import { MAX_SNIPE_CONFIGS_PER_USER } from '@nova/shared';
import {
  handleQuickStart,
  renderSniperStart,
  handlePauseAll,
  handlePauseConfig,
  handleResumeAll,
  handleResumeConfig,
  handleDeleteConfig,
  renderDeleteConfigConfirm,
} from './sniper.js';
import type { ScreenDeps } from '../types.js';

function makeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'config-1',
    userId: 'user-1',
    walletId: null,
    buyAmountSol: 0.1,
    isActive: true,
    autoBuyOnLaunch: true,
    minAiScore: 60,
    ...overrides,
  };
}

function fakeWallet(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'wallet-1',
    userId: 'user-1',
    label: 'Wallet 1',
    publicKey: 'PubkeyAAAAAAAAAAAAAAAAAAAAAA',
    isActive: true,
    ...overrides,
  };
}

function fakeDeps(
  configs: ReturnType<typeof makeConfig>[],
  wallets: ReturnType<typeof fakeWallet>[] = [fakeWallet()],
) {
  const create = vi.fn().mockResolvedValue(undefined);
  const count = vi.fn().mockResolvedValue(configs.length);
  const findMany = vi.fn().mockResolvedValue(configs);
  const findUnique = vi
    .fn()
    .mockImplementation(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(configs.find((c) => c.id === id) ?? null),
    );
  const update = vi.fn().mockImplementation(({ where: { id }, data }: never) => {
    const config = configs.find((c) => c.id === id);
    if (config) Object.assign(config, data);
    return Promise.resolve(config);
  });
  const deleteFn = vi.fn().mockImplementation(({ where: { id } }: { where: { id: string } }) => {
    const idx = configs.findIndex((c) => c.id === id);
    if (idx >= 0) configs.splice(idx, 1);
    return Promise.resolve(undefined);
  });
  const updateMany = vi
    .fn()
    .mockImplementation(
      ({
        where,
        data,
      }: {
        where: { userId: string; isActive?: boolean };
        data: Record<string, unknown>;
      }) => {
        const affected = configs.filter(
          (c) => c.userId === where.userId && (!where.isActive || c.isActive),
        );
        for (const c of affected) Object.assign(c, data);
        return Promise.resolve({ count: affected.length });
      },
    );
  const businessSettingsFindFirst = vi.fn().mockResolvedValue({
    id: 'settings-1',
    performanceFeeBps: 2000,
    referralProgramEnabled: true,
    maxReferralDepth: 2,
    referralLevels: [],
  });
  const walletFindMany = vi.fn().mockResolvedValue(wallets.filter((w) => w.isActive));
  const walletFindFirst = vi.fn().mockResolvedValue(wallets.filter((w) => w.isActive)[0] ?? null);
  const prisma = {
    snipeConfig: { create, count, findMany, findUnique, update, delete: deleteFn, updateMany },
    wallet: { findMany: walletFindMany, findFirst: walletFindFirst },
    businessSettings: { findFirst: businessSettingsFindFirst, create: vi.fn() },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    encryptionKey: 'key',
    logger: { error: vi.fn() } as never,
    // Matches every fixture user's telegramId below, so existing tests keep
    // exercising the fee-policy gate (and everything else) rather than the
    // separate trading-restriction gate covered by its own dedicated test.
    adminIds: new Set(['tg-1']),
    telegramTrend: {
      enabled: false,
      channels: [],
      minAiScore: 50,
      pollIntervalMs: 20000,
      metricsUrl: '',
    },
  } as ScreenDeps;
  return { deps, create, count, findMany, update, deleteFn, updateMany, walletFindMany };
}

// Fee policy already accepted at the current fee %, so these existing tests
// exercise the screen's normal (post-consent-gate) behavior unchanged.
const user = {
  id: 'user-1',
  telegramId: 'tg-1',
  feePolicyAcceptedAt: new Date(),
  feePolicyAcceptedFeeBps: 2000,
} as User;

describe('renderSniperStart', () => {
  it("regression: never builds a message over Telegram's 4096-char limit, however many configs exist", async () => {
    // Live-verified failure: a user who repeatedly tapped "Add Another Config"
    // before the cap existed ended up with 75 duplicate rows, and every line
    // pushed the rendered text past Telegram's 4096-char sendMessage limit —
    // GrammyError 400 "message is too long", permanently breaking this screen.
    const configs = Array.from({ length: 75 }, (_, i) => makeConfig({ id: `config-${i}` }));
    const { deps } = fakeDeps(configs);
    const result = await renderSniperStart(deps, user);
    expect(result.text.length).toBeLessThan(4096);
    expect(result.text).toContain('more (contact support');
  });

  it("regression: never builds a keyboard over Telegram's inline-button limits, however many configs exist", async () => {
    const configs = Array.from({ length: 75 }, (_, i) => makeConfig({ id: `config-${i}` }));
    const { deps } = fakeDeps(configs);
    const result = await renderSniperStart(deps, user);
    const totalButtons = result.keyboard.inline_keyboard.flat().length;
    expect(totalButtons).toBeLessThan(100);
  });

  it('hides the Add Another Config button once at the per-user cap', async () => {
    const configs = Array.from({ length: MAX_SNIPE_CONFIGS_PER_USER }, (_, i) =>
      makeConfig({ id: `config-${i}` }),
    );
    const { deps } = fakeDeps(configs);
    const result = await renderSniperStart(deps, user);
    const buttons = result.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(buttons).not.toContain('➕ Add Another Config (0.1 SOL)');
  });

  it('shows the wallet each config belongs to — old configs (walletId null) show the fallback (first active) wallet', async () => {
    const { deps } = fakeDeps([makeConfig({ walletId: null })], [fakeWallet({ label: 'Main' })]);
    const result = await renderSniperStart(deps, user);
    expect(result.text).toContain('Wallet: Main');
  });

  it('a config pinned to a specific wallet (multiple wallets per user) shows that wallet, not the first one', async () => {
    const wallets = [
      fakeWallet({ id: 'wallet-1', label: 'Main' }),
      fakeWallet({ id: 'wallet-2', label: 'Secondary' }),
    ];
    const { deps } = fakeDeps([makeConfig({ walletId: 'wallet-2' })], wallets);
    const result = await renderSniperStart(deps, user);
    expect(result.text).toContain('Wallet: Secondary');
  });

  it('numbers configs and shows buy amount / min AI score / auto-buy / status per config', async () => {
    const { deps } = fakeDeps([
      makeConfig({
        id: 'config-1',
        buyAmountSol: 0.03,
        minAiScore: 60,
        autoBuyOnLaunch: true,
        isActive: true,
      }),
    ]);
    const result = await renderSniperStart(deps, user);
    expect(result.text).toContain('Sniper #1');
    expect(result.text).toContain('0.0300 SOL');
    expect(result.text).toContain('Min AI Score: 60');
    expect(result.text).toContain('Auto Buy: ON');
    expect(result.text).toContain('Status: Active');
  });
});

describe('handleQuickStart', () => {
  it('regression: refuses to create another config once the user is at the cap', async () => {
    const configs = Array.from({ length: MAX_SNIPE_CONFIGS_PER_USER }, (_, i) =>
      makeConfig({ id: `config-${i}` }),
    );
    const { deps, create } = fakeDeps(configs);
    await handleQuickStart(deps, user);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a config when under the cap, stamped with the first active wallet', async () => {
    const { deps, create } = fakeDeps([makeConfig()], [fakeWallet({ id: 'wallet-1' })]);
    await handleQuickStart(deps, user);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ walletId: 'wallet-1' }) }),
    );
  });
});

describe('pause / resume / delete one config', () => {
  it('pauses exactly the requested config, leaving others untouched', async () => {
    const { deps, update } = fakeDeps([
      makeConfig({ id: 'config-1', isActive: true }),
      makeConfig({ id: 'config-2', isActive: true }),
    ]);
    await handlePauseConfig(deps, user, 'config-1');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'config-1' },
      data: { isActive: false },
    });
  });

  it('resumes exactly the requested config', async () => {
    const { deps, update } = fakeDeps([makeConfig({ id: 'config-1', isActive: false })]);
    await handleResumeConfig(deps, user, 'config-1');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'config-1' },
      data: { isActive: true },
    });
  });

  it('unauthorized: refuses to pause a config belonging to a different user', async () => {
    const { deps, update } = fakeDeps([
      makeConfig({ id: 'config-1', userId: 'someone-else', isActive: true }),
    ]);
    await handlePauseConfig(deps, user, 'config-1');
    expect(update).not.toHaveBeenCalled();
  });

  it('unauthorized: refuses to resume a config belonging to a different user', async () => {
    const { deps, update } = fakeDeps([
      makeConfig({ id: 'config-1', userId: 'someone-else', isActive: false }),
    ]);
    await handleResumeConfig(deps, user, 'config-1');
    expect(update).not.toHaveBeenCalled();
  });

  it('unauthorized: refuses to delete a config belonging to a different user', async () => {
    const { deps, deleteFn } = fakeDeps([makeConfig({ id: 'config-1', userId: 'someone-else' })]);
    await handleDeleteConfig(deps, user, 'config-1');
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('delete confirmation screen never deletes anything itself — only the confirmed action does', async () => {
    const { deps, deleteFn } = fakeDeps([makeConfig({ id: 'config-1' })]);
    const result = await renderDeleteConfigConfirm(deps, user, 'config-1');
    expect(deleteFn).not.toHaveBeenCalled();
    expect(result.text).toContain(
      'wallet, open positions, and full trade/PnL history are never touched',
    );
  });

  it('deleting a config removes only that SnipeConfig row', async () => {
    const { deps, deleteFn } = fakeDeps([makeConfig({ id: 'config-1' })]);
    await handleDeleteConfig(deps, user, 'config-1');
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'config-1' } });
  });

  it('a stale/already-deleted config id is handled gracefully (no throw)', async () => {
    const { deps, deleteFn } = fakeDeps([]);
    await expect(handleDeleteConfig(deps, user, 'missing-id')).resolves.toBeDefined();
    expect(deleteFn).not.toHaveBeenCalled();
  });
});

describe('pause all configs for one user only', () => {
  it('pauses only the active configs belonging to the requesting user, never another user', async () => {
    const { deps, updateMany } = fakeDeps([
      makeConfig({ id: 'config-1', userId: 'user-1', isActive: true }),
      makeConfig({ id: 'config-2', userId: 'user-1', isActive: true }),
    ]);
    const result = await handlePauseAll(deps, user);
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isActive: true },
      data: { isActive: false },
    });
    expect(result.text).toContain('paused successfully (2 config(s))');
  });

  it("never touches another user's configs — the where clause is scoped to userId", async () => {
    const { deps, updateMany } = fakeDeps([makeConfig({ id: 'config-1', isActive: true })]);
    await handlePauseAll(deps, user);
    const call = updateMany.mock.calls[0]?.[0];
    expect(call.where.userId).toBe('user-1');
  });

  it('the paused-confirmation screen points at Open Positions and Close All Positions', async () => {
    const { deps } = fakeDeps([makeConfig({ isActive: true })]);
    const result = await handlePauseAll(deps, user);
    const buttons = result.keyboard.inline_keyboard.flat();
    expect(buttons.some((b) => b.text === '📊 Open Positions')).toBe(true);
    expect(buttons.some((b) => b.text === '🔴 Close All Positions')).toBe(true);
  });
});

describe('fee policy consent gate', () => {
  const unacceptedUser = {
    id: 'user-2',
    telegramId: 'tg-1',
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
      telegramId: 'tg-1',
      feePolicyAcceptedAt: new Date(),
      feePolicyAcceptedFeeBps: 1500,
    } as User;
    const { deps, create } = fakeDeps([]);
    const result = await handleQuickStart(deps, staleUser);
    expect(create).not.toHaveBeenCalled();
    expect(result.text).toContain('Performance Fee & Referral Policy');
  });

  it('handleResumeConfig re-checks the policy gate before resuming (defense in depth)', async () => {
    const { deps, update } = fakeDeps([makeConfig({ id: 'config-1', isActive: false })]);
    const result = await handleResumeConfig(deps, unacceptedUser, 'config-1');
    expect(update).not.toHaveBeenCalled();
    expect(result.text).toContain('Performance Fee & Referral Policy');
  });
});

describe('trading-restriction gate (TELEGRAM_ADMIN_IDS)', () => {
  const otherUser = {
    id: 'user-4',
    telegramId: 'tg-2',
    feePolicyAcceptedAt: new Date(),
    feePolicyAcceptedFeeBps: 2000,
  } as User;

  it('handleQuickStart refuses a non-admin Telegram user before even checking the fee policy', async () => {
    const { deps, create } = fakeDeps([]);
    const result = await handleQuickStart(deps, otherUser);
    expect(create).not.toHaveBeenCalled();
    expect(result.text).toContain('restricted to the bot operator');
  });

  it('handleResumeAll refuses a non-admin Telegram user', async () => {
    const { deps, updateMany } = fakeDeps([makeConfig({ userId: 'user-4', isActive: false })]);
    const result = await handleResumeAll(deps, otherUser);
    expect(updateMany).not.toHaveBeenCalled();
    expect(result.text).toContain('restricted to the bot operator');
  });

  it('handleResumeConfig refuses a non-admin Telegram user', async () => {
    const { deps, update } = fakeDeps([
      makeConfig({ id: 'config-1', userId: 'user-4', isActive: false }),
    ]);
    const result = await handleResumeConfig(deps, otherUser, 'config-1');
    expect(update).not.toHaveBeenCalled();
    expect(result.text).toContain('restricted to the bot operator');
  });

  it('the same admin Telegram user is unaffected', async () => {
    const { deps, create } = fakeDeps([]);
    const result = await handleQuickStart(deps, user);
    expect(create).toHaveBeenCalled();
    expect(result.text).not.toContain('restricted to the bot operator');
  });
});
