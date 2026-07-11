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

function fakePrisma(overrides: {
  ledgerExists?: boolean;
  position?: Record<string, unknown> | null;
  sellTrade?: Record<string, unknown> | null;
  buyTrade?: Record<string, unknown> | null;
  businessSettings?: Record<string, unknown> | null;
  ledgerCreate?: ReturnType<typeof vi.fn>;
  referralRewardCreate?: ReturnType<typeof vi.fn>;
}) {
  const performanceFeeLedgerFindUnique = vi
    .fn()
    .mockResolvedValue(overrides.ledgerExists ? { id: 'existing-ledger' } : null);
  const positionFindUnique = vi.fn().mockResolvedValue(
    overrides.position === undefined
      ? {
          id: 'position-1',
          walletId: 'wallet-1',
          tokenId: 'token-1',
          wallet: { userId: 'user-1' },
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
          referralLevels: [{ level: 1, percentBps: 1000, enabled: true }],
        }
      : overrides.businessSettings,
  );
  const ledgerCreate = overrides.ledgerCreate ?? vi.fn().mockResolvedValue({ id: 'ledger-1' });
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

async function fireEvent(payload: Record<string, unknown>) {
  capturedHandlers.length = 0;
  const { prisma, ledgerCreate, referralRewardCreate } = fakePrisma({});
  registerFeeSystem(fakeDeps(prisma));
  const handler = capturedHandlers[capturedHandlers.length - 1]!;
  handler({ type: 'position.updated', payload });
  // subscriber body is async (fire-and-forget) — flush microtasks.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
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

  it('never creates a fee ledger row for a losing/break-even trade (realizedPnlUsd <= 0)', async () => {
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
