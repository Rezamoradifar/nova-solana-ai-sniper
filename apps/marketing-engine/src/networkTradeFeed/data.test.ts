import { describe, expect, it, vi } from 'vitest';
import {
  fetchNetworkTradeCandidates,
  markNetworkTradePosted,
  scoreNetworkTradeCandidate,
  NETWORK_TRADE_FEED_TYPE,
} from './data.js';

const DEPLOYED_AT = new Date('2020-01-01T00:00:00Z');

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([]) },
    activityFeedPost: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as never;
}

function fakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry1',
    mint: 'MintA',
    walletAddress: 'Wallet111111111111111111111111111111111',
    entryAt: new Date('2026-08-01T00:00:00Z'),
    exitAt: new Date('2026-08-01T02:00:00Z'),
    entrySignature: 'buysig',
    exitSignature: 'sellsig',
    entryPriceUsd: 0.001,
    exitPriceUsd: 0.002,
    entryAmountSol: 1,
    exitAmountSol: 1.8,
    realizedRoiPercent: 80,
    realizedPnlSol: 0.8,
    realizedPnlUsd: 150,
    token: { name: 'Gigachad', symbol: 'GIGA', dex: 'PUMPFUN', aiScore: 72 },
    wallet: { confidenceScore: 65 },
    ...overrides,
  };
}

describe('fetchNetworkTradeCandidates', () => {
  it('maps a real, fully-resolved EXITED row into a candidate', async () => {
    const findMany = vi.fn().mockResolvedValue([fakeRow()]);
    const prisma = fakePrisma({ smartWalletTokenEntry: { findMany } });

    const result = await fetchNetworkTradeCandidates(prisma, 30, DEPLOYED_AT);

    expect(result).toEqual([
      {
        entryId: 'entry1',
        mint: 'MintA',
        tokenName: 'Gigachad',
        tokenSymbol: 'GIGA',
        dex: 'PUMPFUN',
        aiScore: 72,
        walletAddress: 'Wallet111111111111111111111111111111111',
        walletConfidenceScore: 65,
        entryAt: new Date('2026-08-01T00:00:00Z'),
        exitAt: new Date('2026-08-01T02:00:00Z'),
        entrySignature: 'buysig',
        exitSignature: 'sellsig',
        entryPriceUsd: 0.001,
        exitPriceUsd: 0.002,
        entryAmountSol: 1,
        exitAmountSol: 1.8,
        realizedRoiPercent: 80,
        realizedPnlSol: 0.8,
        realizedPnlUsd: 150,
      },
    ]);

    // The underlying query filters to real, fully-resolved exits only.
    const where = findMany.mock.calls[0]![0].where;
    expect(where.status).toBe('EXITED');
    expect(where.entryAmountSol).toEqual({ not: null });
    expect(where.exitAmountSol).toEqual({ not: null });
  });

  it('excludes an entry already posted under the network-trade dedup namespace', async () => {
    const findMany = vi.fn().mockResolvedValue([fakeRow({ id: 'entry1' })]);
    const activityFindMany = vi.fn().mockResolvedValue([{ refId: 'entry1' }]);
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany },
      activityFeedPost: { findMany: activityFindMany, create: vi.fn() },
    });

    const result = await fetchNetworkTradeCandidates(prisma, 30, DEPLOYED_AT);

    expect(result).toEqual([]);
    expect(activityFindMany).toHaveBeenCalledWith({
      where: { feedType: NETWORK_TRADE_FEED_TYPE, refId: { in: ['entry1'] } },
      select: { refId: true },
    });
  });

  it('falls back to a PUMPFUN dex label and undefined optional fields when no Token row exists', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([fakeRow({ token: null, wallet: { confidenceScore: null } })]);
    const prisma = fakePrisma({ smartWalletTokenEntry: { findMany } });

    const [result] = await fetchNetworkTradeCandidates(prisma, 30, DEPLOYED_AT);

    expect(result!.dex).toBe('PUMPFUN');
    expect(result!.tokenName).toBeUndefined();
    expect(result!.aiScore).toBeUndefined();
    expect(result!.walletConfidenceScore).toBeUndefined();
  });
});

describe('markNetworkTradePosted', () => {
  it('writes a dedup row under the network-trade feed type', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const prisma = fakePrisma({ activityFeedPost: { findMany: vi.fn(), create } });

    await markNetworkTradePosted(prisma, 'entry1');

    expect(create).toHaveBeenCalledWith({
      data: { feedType: NETWORK_TRADE_FEED_TYPE, refId: 'entry1' },
    });
  });
});

describe('scoreNetworkTradeCandidate', () => {
  it('scores a large win and an equally large loss the same — losses are not penalized as content', () => {
    const win = scoreNetworkTradeCandidate({
      realizedRoiPercent: 200,
      realizedPnlUsd: 1000,
      walletConfidenceScore: 70,
      entryAmountSol: 2,
      volume24hUsd: 50_000,
    });
    const loss = scoreNetworkTradeCandidate({
      realizedRoiPercent: -200,
      realizedPnlUsd: -1000,
      walletConfidenceScore: 70,
      entryAmountSol: 2,
      volume24hUsd: 50_000,
    });
    expect(win).toBe(loss);
  });

  it('scores a bigger, higher-conviction trade higher than a small, low-confidence one', () => {
    const big = scoreNetworkTradeCandidate({
      realizedRoiPercent: 150,
      realizedPnlUsd: 3000,
      walletConfidenceScore: 90,
      entryAmountSol: 8,
      volume24hUsd: 80_000,
    });
    const small = scoreNetworkTradeCandidate({
      realizedRoiPercent: 5,
      realizedPnlUsd: 10,
      walletConfidenceScore: 10,
      entryAmountSol: 0.1,
      volume24hUsd: 1000,
    });
    expect(big).toBeGreaterThan(small);
  });

  it('never exceeds 100 even for extreme inputs', () => {
    const score = scoreNetworkTradeCandidate({
      realizedRoiPercent: 100_000,
      realizedPnlUsd: 10_000_000,
      walletConfidenceScore: 100,
      entryAmountSol: 1_000_000,
      volume24hUsd: 10_000_000,
    });
    expect(score).toBeLessThanOrEqual(100);
  });

  it('treats an unscored wallet (undefined confidence) as the worst case for that dimension, not a crash', () => {
    expect(() =>
      scoreNetworkTradeCandidate({
        realizedRoiPercent: 50,
        realizedPnlUsd: 500,
        walletConfidenceScore: undefined,
        entryAmountSol: 1,
        volume24hUsd: undefined,
      }),
    ).not.toThrow();
  });
});
