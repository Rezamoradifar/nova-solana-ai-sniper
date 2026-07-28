import { describe, expect, it, vi } from 'vitest';
import {
  fetchNewOpportunityCandidates,
  fetchMarketActivityCandidates,
  fetchTrendingTokenDbCandidates,
  fetchWhaleAlertCandidates,
  fetchSecurityAlertCandidates,
  isWeekAlreadySummarized,
  markActivityFeedPosted,
  FEED_TYPES,
} from './data.js';

const DEPLOYED_AT = new Date('2020-01-01T00:00:00Z');
const NOW = new Date('2026-07-28T12:00:00Z');

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    token: { findMany: vi.fn().mockResolvedValue([]) },
    smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([]) },
    shadowModeDecisionLog: { findMany: vi.fn().mockResolvedValue([]) },
    activityFeedPost: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as never;
}

describe('fetchNewOpportunityCandidates', () => {
  it('excludes tokens already recorded in ActivityFeedPost', async () => {
    const tokens = [
      {
        id: 'tok1',
        mint: 'MintA',
        name: 'A',
        symbol: 'AAA',
        dex: 'RAYDIUM',
        liquidityUsd: 1,
        marketCapUsd: 2,
        aiScore: 90,
        firstSeenAt: new Date(),
      },
      {
        id: 'tok2',
        mint: 'MintB',
        name: 'B',
        symbol: 'BBB',
        dex: 'RAYDIUM',
        liquidityUsd: 1,
        marketCapUsd: 2,
        aiScore: 80,
        firstSeenAt: new Date(),
      },
    ];
    const prisma = fakePrisma({
      token: { findMany: vi.fn().mockResolvedValue(tokens) },
      activityFeedPost: {
        findMany: vi.fn().mockResolvedValue([{ refId: 'tok1' }]),
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    });

    const result = await fetchNewOpportunityCandidates(prisma, 5, DEPLOYED_AT);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('tok2');
  });

  it('bounds the query to firstSeenAt >= deployedAt', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = fakePrisma({ token: { findMany } });
    await fetchNewOpportunityCandidates(prisma, 5, DEPLOYED_AT);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { firstSeenAt: { gte: DEPLOYED_AT } } }),
    );
  });
});

describe('fetchMarketActivityCandidates', () => {
  it('day-buckets its dedup key so the same token can resurface on a new UTC day', async () => {
    const tokens = [
      {
        id: 'tok1',
        mint: 'MintA',
        name: 'A',
        symbol: 'AAA',
        dex: 'RAYDIUM',
        firstSeenAt: new Date('2026-07-27T00:00:00Z'),
      },
    ];
    const create = vi.fn();
    const prisma = fakePrisma({
      token: { findMany: vi.fn().mockResolvedValue(tokens) },
      activityFeedPost: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), create },
    });
    const result = await fetchMarketActivityCandidates(prisma, 5, DEPLOYED_AT, NOW);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(`tok1:2026-07-28`);
  });

  it('excludes a token already posted for the current day bucket', async () => {
    const tokens = [
      {
        id: 'tok1',
        mint: 'MintA',
        name: 'A',
        symbol: 'AAA',
        dex: 'RAYDIUM',
        firstSeenAt: new Date('2026-07-27T00:00:00Z'),
      },
    ];
    const prisma = fakePrisma({
      token: { findMany: vi.fn().mockResolvedValue(tokens) },
      activityFeedPost: {
        findMany: vi.fn().mockResolvedValue([{ refId: 'tok1:2026-07-28' }]),
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    });
    const result = await fetchMarketActivityCandidates(prisma, 5, DEPLOYED_AT, NOW);
    expect(result).toHaveLength(0);
  });

  it('bounds the lookback window to the rolling 48h (or deployedAt, whichever is later)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = fakePrisma({ token: { findMany } });
    await fetchMarketActivityCandidates(prisma, 5, DEPLOYED_AT, NOW);
    const expectedWindowStart = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { firstSeenAt: { gte: expectedWindowStart } } }),
    );
  });
});

describe('fetchTrendingTokenDbCandidates', () => {
  it('returns the raw DB candidate pool, day-bucketed for dedup — live trending check happens elsewhere', async () => {
    const tokens = [
      {
        id: 'tok1',
        mint: 'MintA',
        name: 'A',
        symbol: 'AAA',
        dex: 'RAYDIUM',
        firstSeenAt: new Date('2026-07-28T10:00:00Z'),
      },
    ];
    const prisma = fakePrisma({ token: { findMany: vi.fn().mockResolvedValue(tokens) } });
    const result = await fetchTrendingTokenDbCandidates(prisma, 5, DEPLOYED_AT, NOW);
    expect(result).toEqual([
      {
        id: 'tok1:2026-07-28',
        mint: 'MintA',
        name: 'A',
        symbol: 'AAA',
        dex: 'RAYDIUM',
        detectedAt: tokens[0]!.firstSeenAt,
      },
    ]);
  });

  it('bounds the lookback window to the rolling 24h', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = fakePrisma({ token: { findMany } });
    await fetchTrendingTokenDbCandidates(prisma, 5, DEPLOYED_AT, NOW);
    const expectedWindowStart = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { firstSeenAt: { gte: expectedWindowStart } } }),
    );
  });
});

describe('fetchWhaleAlertCandidates', () => {
  it('filters to wallets meeting the minimum confidence bar', async () => {
    const entries = [
      {
        id: 'e1',
        walletAddress: 'Wallet1',
        mint: 'MintA',
        entryMarketCapUsd: 100,
        entryAt: new Date(),
        wallet: { confidenceScore: 96, winRate: 71 },
        token: { name: 'A', symbol: 'AAA' },
      },
    ];
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue(entries) },
    });
    const result = await fetchWhaleAlertCandidates(prisma, 5, DEPLOYED_AT);
    expect(result).toHaveLength(1);
    expect(result[0]?.confidenceScore).toBe(96);
  });
});

describe('fetchSecurityAlertCandidates', () => {
  it('reads from ShadowModeDecisionLog, the real per-token gate-pass record', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = fakePrisma({ shadowModeDecisionLog: { findMany } });
    await fetchSecurityAlertCandidates(prisma, 5, DEPLOYED_AT);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { detectedAt: { gte: DEPLOYED_AT } } }),
    );
  });
});

describe('dedup guards', () => {
  it('isWeekAlreadySummarized returns false when nothing recorded yet', async () => {
    const prisma = fakePrisma();
    expect(await isWeekAlreadySummarized(prisma, '2026-07-20')).toBe(false);
  });

  it('markActivityFeedPosted writes exactly the feedType/refId pair', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const prisma = fakePrisma({
      activityFeedPost: { findMany: vi.fn(), findUnique: vi.fn(), create },
    });
    await markActivityFeedPosted(prisma, FEED_TYPES.NEW_OPPORTUNITY, 'tok1');
    expect(create).toHaveBeenCalledWith({
      data: { feedType: FEED_TYPES.NEW_OPPORTUNITY, refId: 'tok1' },
    });
  });
});
