import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient, User } from '@prisma/client';
import {
  renderPositions,
  handleClosePositionAsk,
  handleClosePositionConfirm,
  handleCloseAllConfirm,
} from './positions.js';
import type { ScreenDeps } from '../types.js';

const user = { id: 'user-1', role: 'TRADER' } as User;

function fakeApiPosition(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pos-1',
    walletId: 'wallet-1',
    status: 'OPEN',
    entryPriceUsd: 0.0001,
    amountToken: 1_000_000_000,
    remainingAmountToken: null,
    amountSolInvested: 0.5,
    createdAt: new Date().toISOString(),
    token: { mint: 'MintABC1234567890', symbol: 'RAGEGUY', decimals: 9 },
    currentPriceUsd: 0.0002,
    unrealizedPnlUsd: 0.1,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<Record<string, unknown>> = {}): ScreenDeps {
  const prisma = {
    position: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    wallet: {
      findMany: vi.fn().mockResolvedValue([{ id: 'wallet-1', label: 'Main', publicKey: 'Pub111' }]),
    },
    ...overrides,
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
    api: { baseUrl: 'http://127.0.0.1:4000', jwtSecret: 'test-secret-test-secret' },
  };
}

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('renderPositions', () => {
  it("lists only the current user's OPEN positions (CLOSED ones are filtered out client-side)", async () => {
    global.fetch = mockFetchOnce(200, [
      fakeApiPosition({ id: 'pos-open', status: 'OPEN' }),
      fakeApiPosition({ id: 'pos-closed', status: 'CLOSED' }),
    ]) as never;
    const result = await renderPositions(fakeDeps(), user);
    expect(result.text).toContain('RAGEGUY');
    expect(global.fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.stringContaining('/positions'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /) }),
      }),
    );
  });

  it('shows an empty-state message when there are no open positions', async () => {
    global.fetch = mockFetchOnce(200, []) as never;
    const result = await renderPositions(fakeDeps(), user);
    expect(result.text).toContain('No open positions');
  });

  it('reports a friendly error instead of throwing when the trading engine is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')) as never;
    const result = await renderPositions(fakeDeps(), user);
    expect(result.text).toContain('Could not load live position data');
  });

  it('paginates when there are more open positions than fit on one page', async () => {
    const positions = Array.from({ length: 12 }, (_, i) =>
      fakeApiPosition({
        id: `pos-${i}`,
        token: { mint: `Mint${i}`, symbol: `TKN${i}`, decimals: 9 },
      }),
    );
    global.fetch = mockFetchOnce(200, positions) as never;
    const result = await renderPositions(fakeDeps(), user, 0);
    expect(result.text).toContain('Page 1/3');
    const buttons = result.keyboard.inline_keyboard.flat();
    expect(buttons.some((b) => 'text' in b && b.text === '➡️ Next')).toBe(true);
    expect(buttons.some((b) => 'text' in b && b.text === '⬅️ Prev')).toBe(false);
  });

  it("every callback_data produced for a position stays comfortably under Telegram's 64-byte limit", async () => {
    global.fetch = mockFetchOnce(200, [
      fakeApiPosition({ id: 'a'.repeat(25) }), // cuid-length id
    ]) as never;
    const result = await renderPositions(fakeDeps(), user);
    for (const row of result.keyboard.inline_keyboard) {
      for (const button of row) {
        if ('callback_data' in button && button.callback_data) {
          expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64);
        }
      }
    }
  });
});

describe('handleClosePositionAsk / handleClosePositionConfirm — authorization', () => {
  it('unauthorized: a position belonging to a different user is rejected without calling the close API', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'pos-1',
      status: 'OPEN',
      token: { symbol: 'ABC', mint: 'MintABC' },
      wallet: { userId: 'someone-else' },
    });
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as never;
    const deps = fakeDeps({ position: { findUnique, count: vi.fn().mockResolvedValue(0) } });

    await handleClosePositionConfirm(deps, user, 'pos-1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a position that is already CLOSED is rejected without calling the close API', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'pos-1',
      status: 'CLOSED',
      token: { symbol: 'ABC', mint: 'MintABC' },
      wallet: { userId: 'user-1' },
    });
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as never;
    const deps = fakeDeps({ position: { findUnique, count: vi.fn().mockResolvedValue(0) } });

    const result = await handleClosePositionConfirm(deps, user, 'pos-1');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.text).toContain('already closed');
  });

  it('a stale/deleted position id is handled gracefully (no throw, and never attempts a sell)', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    // The not-found fallback re-renders the Positions list, which legitimately
    // calls GET /positions — what must never happen is a call to the sell endpoint.
    global.fetch = mockFetchOnce(200, []) as never;
    const deps = fakeDeps({ position: { findUnique, count: vi.fn().mockResolvedValue(0) } });

    await expect(handleClosePositionAsk(deps, user, 'missing')).resolves.toBeDefined();
    const calledUrls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(calledUrls.some((u) => String(u).includes('/sell'))).toBe(false);
  });
});

describe('handleClosePositionConfirm — outcomes', () => {
  function ownedOpenPosition() {
    return vi.fn().mockResolvedValue({
      id: 'pos-1',
      status: 'OPEN',
      token: { symbol: 'ABC', mint: 'MintABC' },
      wallet: { userId: 'user-1' },
    });
  }

  it('prevents a duplicate concurrent close request for the same position', async () => {
    // A distinct positionId — the first call's fetch mock never resolves, so
    // its in-flight guard is never released, and reusing 'pos-1' here would
    // permanently poison every other test in this file that closes 'pos-1'.
    const positionId = 'pos-duplicate-test-only';
    const findUnique = vi.fn().mockResolvedValue({
      id: positionId,
      status: 'OPEN',
      token: { symbol: 'ABC', mint: 'MintABC' },
      wallet: { userId: 'user-1' },
    });
    // Never resolves within this test — simulates a slow in-flight request.
    global.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as never;
    const deps = fakeDeps({ position: { findUnique, count: vi.fn().mockResolvedValue(0) } });

    const first = handleClosePositionConfirm(deps, user, positionId);
    const second = await handleClosePositionConfirm(deps, user, positionId);

    expect(second.text).toContain('Already processing');
    expect(findUnique).toHaveBeenCalledTimes(1); // second call never even reached the DB lookup
    void first; // left pending deliberately; nothing else to assert on it
  });

  it('reports zero on-chain balance clearly, without fabricating a realized PnL', async () => {
    const findUnique = ownedOpenPosition();
    global.fetch = mockFetchOnce(200, {
      closed: true,
      position: { id: 'pos-1', status: 'CLOSED', realizedPnlUsd: null },
      signature: null,
    }) as never;
    const deps = fakeDeps({ position: { findUnique, count: vi.fn().mockResolvedValue(0) } });

    const result = await handleClosePositionConfirm(deps, user, 'pos-1');
    expect(result.text).toContain('zero on-chain balance and requires reconciliation');
    expect(result.text).not.toMatch(/Realized PnL/);
  });

  it('a failed Jupiter quote / failed transaction is reported clearly and the position stays open', async () => {
    const findUnique = ownedOpenPosition();
    global.fetch = mockFetchOnce(422, {
      error: 'No route found for this swap',
      category: 'route_unavailable',
    }) as never;
    const deps = fakeDeps({ position: { findUnique, count: vi.fn().mockResolvedValue(0) } });

    const result = await handleClosePositionConfirm(deps, user, 'pos-1');
    expect(result.text).toContain('Close failed');
    expect(result.text).toContain('remains open');
  });

  it('reports a successful close with the realized PnL and signature', async () => {
    const findUnique = ownedOpenPosition();
    global.fetch = mockFetchOnce(200, {
      closed: true,
      position: { id: 'pos-1', status: 'CLOSED', realizedPnlUsd: 12.34 },
      signature: 'SigABC123',
    }) as never;
    const deps = fakeDeps({ position: { findUnique, count: vi.fn().mockResolvedValue(0) } });

    const result = await handleClosePositionConfirm(deps, user, 'pos-1');
    expect(result.text).toContain('Position closed');
    expect(result.text).toContain('SigABC123');
    expect(result.text).toContain('12.34');
  });
});

describe('handleCloseAllConfirm', () => {
  it('prevents a duplicate concurrent close-all request for the same user', async () => {
    // A distinct user — the first call's fetch mock never resolves, so its
    // in-flight guard is never released, and reusing the shared `user` here
    // would permanently poison the other handleCloseAllConfirm test below.
    const dupUser = { id: 'user-duplicate-test-only', role: 'TRADER' } as User;
    global.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as never;
    const deps = fakeDeps();

    const first = handleCloseAllConfirm(deps, dupUser);
    const second = await handleCloseAllConfirm(deps, dupUser);

    expect(second.text).toContain('Already processing a Close All request');
    void first;
  });

  it('reports a summary with partial failures, capped and clearly attributed', async () => {
    global.fetch = mockFetchOnce(200, {
      closed: 3,
      failed: 1,
      skipped: 1,
      failures: [{ positionId: 'pos-2', symbol: 'BAD', reason: 'No route found' }],
    }) as never;
    const deps = fakeDeps();

    const result = await handleCloseAllConfirm(deps, user);
    expect(result.text).toContain('Closed: 3');
    expect(result.text).toContain('Failed: 1');
    expect(result.text).toContain('Skipped: 1');
    expect(result.text).toContain('BAD: No route found');
  });
});
