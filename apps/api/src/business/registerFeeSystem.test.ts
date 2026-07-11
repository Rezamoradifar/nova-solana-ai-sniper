import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const capturedHandlers: ((event: { type: string; payload: Record<string, unknown> }) => void)[] =
  [];

vi.mock('../lib/eventBus.js', () => ({
  eventBus: {
    subscribe: (handler: (event: { type: string; payload: Record<string, unknown> }) => void) => {
      capturedHandlers.push(handler);
      return () => {};
    },
  },
}));

vi.mock('@nova/telegram-bot', () => ({
  createBot: vi.fn(),
  NotificationService: vi.fn().mockImplementation(() => ({ notifyTradeReport: vi.fn() })),
}));

vi.mock('../solana/pumpfunBondingCurve.js', () => ({
  sharedSolPriceOracle: { getPriceUsd: vi.fn().mockResolvedValue(150) },
}));

vi.mock('../solana/dexscreener.js', () => ({
  DexScreenerClient: vi.fn().mockImplementation(() => ({})),
}));

import { registerFeeSystem } from './registerFeeSystem.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

// The fee system's own activation timestamp used across these fixtures —
// deliberately in the past relative to every "closedAt" default below, so
// the existing test suite continues to exercise a position that closed
// *after* activation (the normal case) unless a test explicitly backdates
// closedAt to test the historical-replay guard itself.
const FEE_SYSTEM_ACTIVATED_AT = new Date('2026-07-11T22:56:38Z');
const AFTER_ACTIVATION = new Date('2026-07-12T00:00:00Z');
const BEFORE_ACTIVATION = new Date('2026-07-10T12:00:00Z');

function fakePrisma(overrides: {
  ledgerExists?: boolean;
  position?: Record<string, unknown> | null;
  sellTrade?: Record<string, unknown> | null;
  buyTrade?: Record<string, unknown> | null;
  businessSettings?: Record<string, unknown> | null;
  ledgerCreate?: ReturnType<typeof vi.fn>;
  referralRewardCreate?: ReturnType<typeof vi.fn>;
  /** Simulates an "existing user" (account created long before the fee
   * system was deployed) vs. a "new user" — this field is threaded through
   * purely so tests can assert the SYSTEM never reads it to make a fee
   * decision; isEligibleForFeeProcessing never takes a user/account-age
   * parameter at all. */
  userCreatedAt?: Date;
}) {
  const ledgerCreate = overrides.ledgerCreate ?? vi.fn().mockResolvedValue({ id: 'ledger-1' });
  // Stateful, not a fixed return value: introspects ledgerCreate's own call
  // history to see whether THIS positionId already got a row this run, so a
  // test that fires the same positionId twice genuinely exercises the
  // idempotency guard rather than asserting on a mock that can't remember
  // anything between calls.
  const performanceFeeLedgerFindUnique = vi
    .fn()
    .mockImplementation(({ where }: { where: { positionId: string } }) => {
      const alreadyCharged =
        overrides.ledgerExists ||
        ledgerCreate.mock.calls.some((call) => call[0]?.data?.positionId === where.positionId);
      return Promise.resolve(alreadyCharged ? { id: 'existing-ledger' } : null);
    });
  const positionFindUnique = vi.fn().mockResolvedValue(
    overrides.position === undefined
      ? {
          id: 'position-1',
          walletId: 'wallet-1',
          tokenId: 'token-1',
          closedAt: AFTER_ACTIVATION,
          wallet: { userId: 'user-1', createdAt: overrides.userCreatedAt ?? BEFORE_ACTIVATION },
          token: { symbol: 'FOO', mint: 'MintFoo1111111111111111111111111111111111' },
        }
      : overrides.position,
  );
  const tradeFindFirst = vi.fn().mockImplementation(({ where }: { where: { side: string } }) => {
    if (where.side === 'SELL') {
      return Promise.resolve(
        overrides.sellTrade === undefined
          ? { id: 'sell-trade-1', amountSol: 1.1 }
          : overrides.sellTrade,
      );
    }
    return Promise.resolve(
      overrides.buyTrade === undefined ? { id: 'buy-trade-1', amountSol: 1.0 } : overrides.buyTrade,
    );
  });
  const businessSettingsFindFirst = vi.fn().mockResolvedValue(
    overrides.businessSettings === undefined
      ? {
          id: 'settings-1',
          performanceFeeBps: 2000,
          referralProgramEnabled: true,
          maxReferralDepth: 2,
          feeSystemActivatedAt: FEE_SYSTEM_ACTIVATED_AT,
          referralLevels: [{ level: 1, percentBps: 1000, enabled: true }],
        }
      : overrides.businessSettings,
  );
  const referralRewardCreate = overrides.referralRewardCreate ?? vi.fn().mockResolvedValue({});
  // user-1 (the trader) was referred by user-2 (referralCode 'REF-2') — exercises
  // the referral-reward path by default; individual tests can still override
  // businessSettings.referralProgramEnabled to turn it off.
  const userFindUnique = vi
    .fn()
    .mockImplementation(({ where }: { where: { id?: string; referralCode?: string } }) => {
      if (where.id === 'user-1') return Promise.resolve({ referredByCode: 'REF-2' });
      if (where.referralCode === 'REF-2')
        return Promise.resolve({ id: 'user-2', referredByCode: null });
      return Promise.resolve(null);
    });

  const prisma = {
    performanceFeeLedger: { findUnique: performanceFeeLedgerFindUnique },
    position: { findUnique: positionFindUnique },
    trade: { findFirst: tradeFindFirst },
    businessSettings: { findFirst: businessSettingsFindFirst, create: vi.fn() },
    user: { findUnique: userFindUnique },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        performanceFeeLedger: { create: ledgerCreate },
        referralReward: { create: referralRewardCreate },
      }),
    ),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    ledgerCreate,
    referralRewardCreate,
    performanceFeeLedgerFindUnique,
  };
}

function fakeDeps(prisma: PrismaClient) {
  return {
    prisma,
    log: fakeLogger(),
    config: {
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_CHAT_ID: undefined,
      DEXSCREENER_API_BASE: 'https://x',
    },
  };
}

async function flush() {
  // subscriber body is async (fire-and-forget) — flush microtasks.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function fireEvent(
  payload: Record<string, unknown>,
  prismaOverrides: Parameters<typeof fakePrisma>[0] = {},
) {
  capturedHandlers.length = 0;
  const { prisma, ledgerCreate, referralRewardCreate } = fakePrisma(prismaOverrides);
  registerFeeSystem(fakeDeps(prisma));
  const handler = capturedHandlers[capturedHandlers.length - 1]!;
  handler({ type: 'position.updated', payload });
  await flush();
  return { ledgerCreate, referralRewardCreate };
}

describe('registerFeeSystem', () => {
  it('ignores events that are not position.updated', async () => {
    capturedHandlers.length = 0;
    const { prisma, ledgerCreate } = fakePrisma({});
    registerFeeSystem(fakeDeps(prisma));
    const handler = capturedHandlers[capturedHandlers.length - 1]!;
    handler({ type: 'trade.created', payload: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('ignores a position.updated event that is not a CLOSE', async () => {
    const { ledgerCreate } = await fireEvent({ positionId: 'position-1', status: 'OPEN' });
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('requirement 8: losing trade — never creates a fee ledger row', async () => {
    const { ledgerCreate } = await fireEvent({
      positionId: 'position-1',
      status: 'CLOSED',
      realizedPnlUsd: -25,
    });
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('requirement 8: break-even trade (exactly $0 realized PnL) — never creates a fee ledger row', async () => {
    const { ledgerCreate } = await fireEvent({
      positionId: 'position-1',
      status: 'CLOSED',
      realizedPnlUsd: 0,
    });
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('never creates a fee ledger row for the zero-balance-reconciliation close (no realizedPnlUsd at all)', async () => {
    const { ledgerCreate } = await fireEvent({ positionId: 'position-1', status: 'CLOSED' });
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('creates a fee ledger row + referral reward for a genuinely profitable close', async () => {
    const { ledgerCreate, referralRewardCreate } = await fireEvent({
      positionId: 'position-1',
      status: 'CLOSED',
      realizedPnlUsd: 100,
    });
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
    expect(ledgerCreate.mock.calls[0]![0].data).toMatchObject({
      positionId: 'position-1',
      userId: 'user-1',
      feeBps: 2000,
    });
    expect(referralRewardCreate).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — does nothing if a ledger row already exists for this position', async () => {
    capturedHandlers.length = 0;
    const { prisma, ledgerCreate } = fakePrisma({ ledgerExists: true });
    registerFeeSystem(fakeDeps(prisma));
    const handler = capturedHandlers[capturedHandlers.length - 1]!;
    handler({
      type: 'position.updated',
      payload: { positionId: 'position-1', status: 'CLOSED', realizedPnlUsd: 100 },
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(ledgerCreate).not.toHaveBeenCalled();
  });
});

describe('registerFeeSystem — backward compatibility (requirement 8 matrix)', () => {
  it('requirement 8: existing user (account created long before deployment) is charged normally on a profitable close after deployment', async () => {
    const { ledgerCreate } = await fireEvent(
      { positionId: 'position-1', status: 'CLOSED', realizedPnlUsd: 100 },
      { userCreatedAt: new Date('2020-01-01T00:00:00Z') }, // account far older than the fee system itself
    );
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
    expect(ledgerCreate.mock.calls[0]![0].data).toMatchObject({ userId: 'user-1' });
  });

  it('requirement 8: new user (account created after deployment) is charged normally on their first profitable close', async () => {
    const { ledgerCreate } = await fireEvent(
      { positionId: 'position-1', status: 'CLOSED', realizedPnlUsd: 100 },
      { userCreatedAt: new Date('2026-07-12T01:00:00Z') }, // created after activation
    );
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
  });

  it('requirement 8: detects and charges the first profitable trade closed after deployment', async () => {
    const { ledgerCreate } = await fireEvent({
      positionId: 'position-1',
      status: 'CLOSED',
      realizedPnlUsd: 42,
    });
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
    expect(ledgerCreate.mock.calls[0]![0].data.grossProfitUsd).toBeGreaterThan(0);
  });

  it('requirement 2 & 6: never reprocesses a position that closed BEFORE the fee system was activated, even if it somehow re-fires', async () => {
    const { ledgerCreate } = await fireEvent(
      { positionId: 'old-position', status: 'CLOSED', realizedPnlUsd: 500 },
      {
        position: {
          id: 'old-position',
          walletId: 'wallet-1',
          tokenId: 'token-1',
          closedAt: BEFORE_ACTIVATION, // closed before the fee system existed
          wallet: { userId: 'user-1', createdAt: BEFORE_ACTIVATION },
          token: { symbol: 'FOO', mint: 'MintFoo1111111111111111111111111111111111' },
        },
      },
    );
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('requirement 7: multiple profitable closes are each recorded independently and idempotently', async () => {
    capturedHandlers.length = 0;
    const ledgerCreate = vi.fn().mockResolvedValue({ id: 'ledger-multi' });
    const { prisma } = fakePrisma({ ledgerCreate });
    registerFeeSystem(fakeDeps(prisma));
    const handler = capturedHandlers[capturedHandlers.length - 1]!;

    handler({
      type: 'position.updated',
      payload: { positionId: 'position-A', status: 'CLOSED', realizedPnlUsd: 100 },
    });
    await flush();
    handler({
      type: 'position.updated',
      payload: { positionId: 'position-B', status: 'CLOSED', realizedPnlUsd: 250 },
    });
    await flush();
    // Re-firing the first one again (e.g. a duplicate event) must not double-charge.
    handler({
      type: 'position.updated',
      payload: { positionId: 'position-A', status: 'CLOSED', realizedPnlUsd: 100 },
    });
    await flush();

    expect(ledgerCreate).toHaveBeenCalledTimes(2);
    const positionIds = ledgerCreate.mock.calls.map((call) => call[0].data.positionId);
    expect(positionIds).toEqual(['position-A', 'position-B']);
  });
});
