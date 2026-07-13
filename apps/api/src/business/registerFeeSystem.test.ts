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
  /** All CONFIRMED SELL trades for this position (partial exits + the final
   * close) — takes precedence over `sellTrade` when set, for scenarios that
   * need more than one (e.g. institutional-mode partial exits). */
  sellTrades?: Record<string, unknown>[];
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
          createdAt: BEFORE_ACTIVATION,
          closedAt: AFTER_ACTIVATION,
          wallet: { userId: 'user-1', createdAt: overrides.userCreatedAt ?? BEFORE_ACTIVATION },
          token: { symbol: 'FOO', mint: 'MintFoo1111111111111111111111111111111111' },
        }
      : overrides.position,
  );
  const tradeFindFirst = vi.fn().mockImplementation((_args: { where: { side: string } }) => {
    // BUY only — the SELL side is now a sum-of-all-trades findMany (see below).
    return Promise.resolve(
      overrides.buyTrade === undefined ? { id: 'buy-trade-1', amountSol: 1.0 } : overrides.buyTrade,
    );
  });
  const defaultSellTrades = () => {
    if (overrides.sellTrades !== undefined) return overrides.sellTrades;
    if (overrides.sellTrade === undefined) return [{ id: 'sell-trade-1', amountSol: 1.1 }];
    return overrides.sellTrade === null ? [] : [overrides.sellTrade];
  };
  const tradeFindMany = vi.fn().mockImplementation(({ where }: { where: { side: string } }) => {
    if (where.side === 'SELL') return Promise.resolve(defaultSellTrades());
    return Promise.resolve([]);
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
  // writeLedgerAndAudit (see @nova/shared) writes both of these inside the
  // same $transaction for every PROFIT_CREDIT/OWNER_FEE/REFERRAL_CREDIT —
  // stubbed so the transaction callback below doesn't throw on
  // tx.ledgerEntry.create / tx.auditLog.create being undefined.
  const ledgerEntryCreate = vi.fn().mockResolvedValue({ id: 'ledger-entry-1' });
  const auditLogCreate = vi.fn().mockResolvedValue({ id: 'audit-log-1' });
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
    trade: { findFirst: tradeFindFirst, findMany: tradeFindMany },
    businessSettings: { findFirst: businessSettingsFindFirst, create: vi.fn() },
    user: { findUnique: userFindUnique },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        performanceFeeLedger: { create: ledgerCreate },
        referralReward: { create: referralRewardCreate },
        ledgerEntry: { create: ledgerEntryCreate },
        auditLog: { create: auditLogCreate },
      }),
    ),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    ledgerCreate,
    referralRewardCreate,
    ledgerEntryCreate,
    auditLogCreate,
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
  const { prisma, ledgerCreate, referralRewardCreate, ledgerEntryCreate, auditLogCreate } =
    fakePrisma(prismaOverrides);
  registerFeeSystem(fakeDeps(prisma));
  const handler = capturedHandlers[capturedHandlers.length - 1]!;
  handler({ type: 'position.updated', payload });
  await flush();
  return { ledgerCreate, referralRewardCreate, ledgerEntryCreate, auditLogCreate };
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

  it('writes an immutable LedgerEntry + AuditLog pair for PROFIT_CREDIT, OWNER_FEE, and each REFERRAL_CREDIT', async () => {
    const { ledgerEntryCreate, auditLogCreate } = await fireEvent({
      positionId: 'position-1',
      status: 'CLOSED',
      realizedPnlUsd: 100,
    });

    // PROFIT_CREDIT (trader) + OWNER_FEE (platform) + one REFERRAL_CREDIT
    // (the default fixture has one referral level) = 3 of each.
    expect(ledgerEntryCreate).toHaveBeenCalledTimes(3);
    expect(auditLogCreate).toHaveBeenCalledTimes(3);

    const ledgerTypes = ledgerEntryCreate.mock.calls.map((call) => call[0].data.type);
    expect(ledgerTypes.sort()).toEqual(['OWNER_FEE', 'PROFIT_CREDIT', 'REFERRAL_CREDIT'].sort());

    const profitCredit = ledgerEntryCreate.mock.calls.find(
      (call) => call[0].data.type === 'PROFIT_CREDIT',
    )![0].data;
    expect(profitCredit).toMatchObject({
      asset: 'USD',
      direction: 'CREDIT',
      userId: 'user-1',
      walletId: 'wallet-1',
      referenceType: 'performance_fee_ledger',
    });

    const referralCredit = ledgerEntryCreate.mock.calls.find(
      (call) => call[0].data.type === 'REFERRAL_CREDIT',
    )![0].data;
    // Credited to the referrer (user-2), not the trader whose close triggered it.
    expect(referralCredit.userId).toBe('user-2');

    const auditActions = auditLogCreate.mock.calls.map((call) => call[0].data.action);
    expect(auditActions.sort()).toEqual(
      ['fee.owner_fee_charged', 'fee.profit_credited', 'fee.referral_credited'].sort(),
    );
  });

  it('regression (Profit Distribution Audit, 2026-07-12): sums ALL sell trades for a position with prior partial exits, not just the latest one — a genuinely profitable institutional-mode close is no longer wrongly zero-feed', async () => {
    // Institutional mode: a partial exit already returned 0.5 SOL, and the
    // final close (the trade findFirst used to fetch alone) returned 0.7 SOL
    // — total 1.2 SOL back against a 1.0 SOL buy-in, a real $30 net profit at
    // $150/SOL. Before the fix, only the final leg's 0.7 SOL was compared
    // against the FULL 1.0 SOL buy-in -> a false -$45 "actual net loss" that
    // zeroed the fee out entirely (calculatePerformanceFee's netProfitUsd
    // clamp) despite realizedPnlUsd (100, the position's true accumulated
    // gross profit across every leg) being genuinely positive.
    const { ledgerCreate } = await fireEvent(
      { positionId: 'position-1', status: 'CLOSED', realizedPnlUsd: 100 },
      {
        sellTrades: [
          { id: 'sell-trade-partial-1', amountSol: 0.5 },
          { id: 'sell-trade-final-1', amountSol: 0.7 },
        ],
        buyTrade: { id: 'buy-trade-1', amountSol: 1.0 },
      },
    );
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
    const data = ledgerCreate.mock.calls[0]![0].data;
    expect(data.grossProfitUsd).toBe(100);
    // netProfitUsd clamps to the smaller of gross (100) and actual
    // ((0.5+0.7-1.0)*150 = 30) -- 30, not a false negative.
    expect(data.netProfitUsd).toBeCloseTo(30, 8);
    expect(data.feeUsd).toBeCloseTo(6, 8); // 20% of 30
    expect(data.tradingCostsUsd).toBeCloseTo(70, 8); // 100 - 30
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
