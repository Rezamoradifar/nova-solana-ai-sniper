import { describe, expect, it, vi } from 'vitest';
import {
  closeAllOpenPositions,
  loadOpenPositionAny,
  loadOwnedOpenPosition,
  manualPartialSellAmount,
  nextManualTierIndex,
  partialSellSchema,
} from './positions.js';

describe('partialSellSchema', () => {
  it('accepts percents in (0, 100)', () => {
    expect(partialSellSchema.safeParse({ percent: 1 }).success).toBe(true);
    expect(partialSellSchema.safeParse({ percent: 50 }).success).toBe(true);
    expect(partialSellSchema.safeParse({ percent: 99 }).success).toBe(true);
  });

  it('rejects 0, 100, and negative percents — a partial sell can never be a no-op or a full close', () => {
    expect(partialSellSchema.safeParse({ percent: 0 }).success).toBe(false);
    expect(partialSellSchema.safeParse({ percent: 100 }).success).toBe(false);
    expect(partialSellSchema.safeParse({ percent: -10 }).success).toBe(false);
  });
});

describe('manualPartialSellAmount', () => {
  it('computes the floor of remaining * percent/100, same raw-unit convention as Position.amountToken', () => {
    expect(manualPartialSellAmount(1000, 25)).toBe(250);
    expect(manualPartialSellAmount(999, 50)).toBe(499);
  });

  it('never sells more than what remains, even at the 99% ceiling', () => {
    expect(manualPartialSellAmount(100, 99)).toBeLessThan(100);
  });
});

describe('nextManualTierIndex', () => {
  it('starts at -1 for the first manual sell on a position', () => {
    expect(nextManualTierIndex(0)).toBe(-1);
  });

  it("produces a strictly negative, incrementing sequence that can never collide with the institutional ladder's non-negative tier indices", () => {
    expect(nextManualTierIndex(1)).toBe(-2);
    expect(nextManualTierIndex(2)).toBe(-3);
    for (let manualSellsSoFar = 0; manualSellsSoFar < 20; manualSellsSoFar++) {
      expect(nextManualTierIndex(manualSellsSoFar)).toBeLessThan(0);
    }
  });
});

function fakeFastify(position: unknown) {
  return {
    prisma: {
      position: {
        findUnique: vi.fn().mockResolvedValue(position),
      },
    },
  } as never;
}

describe('loadOwnedOpenPosition', () => {
  it('returns the position when it exists, is OPEN, and belongs to the requesting user', async () => {
    const position = { id: 'p1', status: 'OPEN', wallet: { userId: 'user-1' } };
    const result = await loadOwnedOpenPosition(fakeFastify(position), 'user-1', 'p1');
    expect(result).toEqual({ position });
  });

  it('returns 404 when the position does not exist', async () => {
    const result = await loadOwnedOpenPosition(fakeFastify(null), 'user-1', 'missing');
    expect(result).toEqual({ error: 404 });
  });

  it('returns 404 when the position belongs to a different user — never leaks existence to a non-owner', async () => {
    const position = { id: 'p1', status: 'OPEN', wallet: { userId: 'someone-else' } };
    const result = await loadOwnedOpenPosition(fakeFastify(position), 'user-1', 'p1');
    expect(result).toEqual({ error: 404 });
  });

  it('returns 409 for a position that is already CLOSED — the exact case that must not double-sell', async () => {
    const position = { id: 'p1', status: 'CLOSED', wallet: { userId: 'user-1' } };
    const result = await loadOwnedOpenPosition(fakeFastify(position), 'user-1', 'p1');
    expect(result).toEqual({ error: 409 });
  });
});

describe('loadOpenPositionAny', () => {
  it('returns the position when it exists and is OPEN, regardless of which user owns it', async () => {
    const position = { id: 'p1', status: 'OPEN', wallet: { userId: 'someone-else' } };
    const result = await loadOpenPositionAny(fakeFastify(position), 'p1');
    expect(result).toEqual({ position });
  });

  it('returns 404 when the position does not exist', async () => {
    const result = await loadOpenPositionAny(fakeFastify(null), 'missing');
    expect(result).toEqual({ error: 404 });
  });

  it('returns 409 for a position that is already CLOSED — the exact case that must not double-sell', async () => {
    const position = { id: 'p1', status: 'CLOSED', wallet: { userId: 'someone-else' } };
    const result = await loadOpenPositionAny(fakeFastify(position), 'p1');
    expect(result).toEqual({ error: 409 });
  });
});

function fakePosition(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pos-1',
    walletId: 'wallet-1',
    tokenId: 'token-1',
    token: { mint: 'MintABC', symbol: 'ABC', decimals: 9 },
    wallet: { encryptedSecret: 'enc' },
    ...overrides,
  };
}

function fakeCloseAllFastify(
  options: {
    wallets?: Array<{ id: string }>;
    positions?: unknown[];
    getBestSolanaPair?: ReturnType<typeof vi.fn>;
    closePosition?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const wallets = options.wallets ?? [{ id: 'wallet-1' }];
  const positions = options.positions ?? [fakePosition()];
  const walletFindMany = vi.fn().mockResolvedValue(wallets);
  const fastify = {
    prisma: {
      wallet: { findMany: walletFindMany },
      position: { findMany: vi.fn().mockResolvedValue(positions) },
    },
    dexScreener: {
      getBestSolanaPair:
        options.getBestSolanaPair ?? vi.fn().mockResolvedValue({ priceUsd: '1.5' }),
    },
    positionManager: {
      closePosition:
        options.closePosition ??
        vi.fn().mockResolvedValue({
          closed: true,
          position: { status: 'CLOSED', realizedPnlUsd: 1 },
          signature: 'sig123',
        }),
    },
    config: { ENCRYPTION_KEY: 'key' },
  };
  return { fastify: fastify as never, walletFindMany };
}

describe('closeAllOpenPositions', () => {
  it('only ever looks up positions belonging to the given userId — never another user', async () => {
    const { fastify, walletFindMany } = fakeCloseAllFastify();
    await closeAllOpenPositions(fastify, 'user-1');
    expect(walletFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });

  it('counts a successful sell as closed', async () => {
    const { fastify } = fakeCloseAllFastify();
    const result = await closeAllOpenPositions(fastify, 'user-1');
    expect(result).toEqual({ closed: 1, failed: 0, skipped: 0, failures: [] });
  });

  it('skips (does not count as closed or failed) a position with no current price available', async () => {
    const { fastify } = fakeCloseAllFastify({
      getBestSolanaPair: vi.fn().mockResolvedValue(undefined),
    });
    const result = await closeAllOpenPositions(fastify, 'user-1');
    expect(result.closed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failures[0]?.reason).toMatch(/no current price/i);
  });

  it('treats a zero-balance reconciliation (signature: null, closed: true) as skipped, not closed, and never fabricates PnL', async () => {
    const { fastify } = fakeCloseAllFastify({
      closePosition: vi
        .fn()
        .mockResolvedValue({ closed: true, position: { status: 'CLOSED' }, signature: null }),
    });
    const result = await closeAllOpenPositions(fastify, 'user-1');
    expect(result.closed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failures[0]?.reason).toMatch(/zero on-chain balance/i);
  });

  it('treats a race (already handled by another operation, closed: false) as skipped', async () => {
    const { fastify } = fakeCloseAllFastify({
      closePosition: vi
        .fn()
        .mockResolvedValue({ closed: false, position: { status: 'OPEN' }, signature: null }),
    });
    const result = await closeAllOpenPositions(fastify, 'user-1');
    expect(result.skipped).toBe(1);
    expect(result.failures[0]?.reason).toMatch(/already handled/i);
  });

  it('a failed Jupiter quote / failed transaction is counted as failed, with a human-readable reason', async () => {
    const { fastify } = fakeCloseAllFastify({
      closePosition: vi.fn().mockRejectedValue(new Error('Jupiter quote failed: 500')),
    });
    const result = await closeAllOpenPositions(fastify, 'user-1');
    expect(result.failed).toBe(1);
    expect(result.failures[0]?.reason).toBe('Jupiter quote failed: 500');
  });

  it('one failed close never stops the rest of the batch — partial failures are isolated per-position', async () => {
    const closePosition = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        closed: true,
        position: { status: 'CLOSED', realizedPnlUsd: 5 },
        signature: 'sig-2',
      });
    const { fastify } = fakeCloseAllFastify({
      positions: [
        fakePosition({ id: 'pos-1', token: { mint: 'Mint1', symbol: 'ONE', decimals: 9 } }),
        fakePosition({ id: 'pos-2', token: { mint: 'Mint2', symbol: 'TWO', decimals: 9 } }),
      ],
      closePosition,
    });
    const result = await closeAllOpenPositions(fastify, 'user-1');
    expect(result.closed).toBe(1);
    expect(result.failed).toBe(1);
    expect(closePosition).toHaveBeenCalledTimes(2);
  });
});
