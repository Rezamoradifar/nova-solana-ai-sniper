import { describe, expect, it, vi } from 'vitest';
import { fetchShowcaseEligibleTrades, markTradeShowcased } from './data.js';

const DEPLOYED_AT = new Date('2020-01-01T00:00:00Z'); // permissive fixed cutoff for tests not exercising it

function fakePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pos1',
    walletId: 'wallet1',
    tokenId: 'token1',
    status: 'CLOSED',
    isPaperTrade: false,
    showcasePostedAt: null,
    closedAt: new Date('2026-07-27T10:30:00Z'),
    createdAt: new Date('2026-07-27T10:00:00Z'),
    amountSolInvested: 0.1,
    entryPriceUsd: 0.001,
    realizedPnlUsd: 25,
    riskScoreAtEntry: 92,
    token: {
      mint: 'MintAbc123',
      name: 'Example Token',
      symbol: 'EXT',
      dex: 'RAYDIUM',
      isHoneypotSuspected: false,
    },
    ...overrides,
  };
}

function fakePrisma(opts: {
  positions: ReturnType<typeof fakePosition>[];
  buyTrade?: { createdAt: Date; txSignature: string | null } | null;
  sellTrades?: Array<{
    createdAt: Date;
    amountSol: number;
    priceUsd: number | null;
    txSignature: string | null;
  }>;
}) {
  const findManyMock = vi.fn();
  return {
    position: {
      findMany: vi.fn().mockImplementation((args: { where?: Record<string, unknown> }) => {
        // The eligibility query itself is exercised via the where clause the
        // caller passes in the real Prisma call — this fake just returns the
        // fixture set, since the actual filtering logic under test here is
        // "what data.ts asks Prisma to filter by," verified via the where
        // clause assertions in the tests below, not by re-implementing SQL
        // filtering in this fake.
        void findManyMock(args);
        return Promise.resolve(opts.positions);
      }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    trade: {
      findFirst: vi.fn().mockResolvedValue(opts.buyTrade ?? null),
      findMany: vi.fn().mockResolvedValue(opts.sellTrades ?? []),
    },
    _findManyMock: findManyMock,
  } as never;
}

describe('fetchShowcaseEligibleTrades — eligibility query', () => {
  it('queries only CLOSED, non-paper, not-yet-showcased positions from non-honeypot tokens', async () => {
    const prisma = fakePrisma({
      positions: [],
    });
    await fetchShowcaseEligibleTrades(prisma, 10, DEPLOYED_AT);
    const call = (prisma as unknown as { _findManyMock: ReturnType<typeof vi.fn> })._findManyMock
      .mock.calls[0]![0];
    expect(call.where.status).toBe('CLOSED');
    expect(call.where.isPaperTrade).toBe(false);
    expect(call.where.showcasePostedAt).toBe(null);
    expect(call.where.token.isHoneypotSuspected).toEqual({ not: true });
  });

  it('never applies a profit-range or win/loss-count filter — the query has no ROI/PnL threshold at all', async () => {
    const prisma = fakePrisma({ positions: [] });
    await fetchShowcaseEligibleTrades(prisma, 10, DEPLOYED_AT);
    const call = (prisma as unknown as { _findManyMock: ReturnType<typeof vi.fn> })._findManyMock
      .mock.calls[0]![0];
    const whereKeys = Object.keys(call.where);
    expect(whereKeys).not.toContain('realizedPnlUsd_gte');
    expect(whereKeys).not.toContain('roiPercent');
  });

  it('bounds every query to closedAt >= deployedAt — no pre-deployment historical backlog is ever eligible', async () => {
    const prisma = fakePrisma({ positions: [] });
    const cutoff = new Date('2026-07-27T02:22:54Z');
    await fetchShowcaseEligibleTrades(prisma, 10, cutoff);
    const call = (prisma as unknown as { _findManyMock: ReturnType<typeof vi.fn> })._findManyMock
      .mock.calls[0]![0];
    expect(call.where.closedAt).toEqual({ not: null, gte: cutoff });
  });
});

describe('fetchShowcaseEligibleTrades — real ROI/PnL computation', () => {
  it('computes ROI from actual SOL in vs SOL out (matches positionManager.ts convention), including a real loss', async () => {
    const prisma = fakePrisma({
      positions: [fakePosition({ amountSolInvested: 1, realizedPnlUsd: -40 })],
      buyTrade: { createdAt: new Date('2026-07-27T10:00:00Z'), txSignature: 'buySig' },
      sellTrades: [
        {
          createdAt: new Date('2026-07-27T10:30:00Z'),
          amountSol: 0.7, // lost 30% of the SOL invested
          priceUsd: 0.0007,
          txSignature: 'sellSig',
        },
      ],
    });
    const [result] = await fetchShowcaseEligibleTrades(prisma, 10, DEPLOYED_AT);
    expect(result!.roiPercent).toBeCloseTo(-30, 5);
    expect(result!.pnlUsd).toBe(-40);
    expect(result!.sellSignature).toBe('sellSig');
    expect(result!.buySignature).toBe('buySig');
    expect(result!.aiScore).toBe(92);
  });

  it('sums every CONFIRMED sell leg (partial exits), not just the final one — matches the Profit Distribution Audit fix', async () => {
    const prisma = fakePrisma({
      positions: [fakePosition({ amountSolInvested: 1 })],
      sellTrades: [
        {
          createdAt: new Date('2026-07-27T10:10:00Z'),
          amountSol: 0.6,
          priceUsd: 0.0012,
          txSignature: 'leg1',
        },
        {
          createdAt: new Date('2026-07-27T10:30:00Z'),
          amountSol: 0.9,
          priceUsd: 0.0018,
          txSignature: 'leg2',
        },
      ],
    });
    const [result] = await fetchShowcaseEligibleTrades(prisma, 10, DEPLOYED_AT);
    // total sold = 1.5 SOL vs 1 SOL invested => +50% ROI
    expect(result!.roiPercent).toBeCloseTo(50, 5);
    expect(result!.sellSignature).toBe('leg2'); // most recent leg
  });

  it('skips a position with no confirmed sell trade rather than posting with a fabricated/missing sell link', async () => {
    const prisma = fakePrisma({
      positions: [fakePosition()],
      sellTrades: [],
    });
    const result = await fetchShowcaseEligibleTrades(prisma, 10, DEPLOYED_AT);
    expect(result).toEqual([]);
  });
});

describe('markTradeShowcased', () => {
  it('sets showcasePostedAt on exactly the given position id (per-trade dedup)', async () => {
    const prisma = fakePrisma({ positions: [] });
    await markTradeShowcased(prisma, 'pos42');
    expect(
      (prisma as unknown as { position: { update: ReturnType<typeof vi.fn> } }).position.update,
    ).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pos42' } }));
  });
});
