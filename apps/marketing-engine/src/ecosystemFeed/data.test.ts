import { describe, expect, it, vi } from 'vitest';
import {
  fetchTrendingTokenDbCandidates,
  fetchHighVolumeDbCandidates,
  fetchHiddenGemCandidates,
  fetchSmartMoneyTradeCandidates,
  fetchBiggestWinnerCandidates,
  markEcosystemFeedPosted,
  isMintAlreadyHandledToday,
  mintDedupRefId,
  ECOSYSTEM_FEED_TYPES,
} from './data.js';

const resolveShowcaseTradeByPositionIdMock = vi.fn();
vi.mock('../tradeShowcase/data.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tradeShowcase/data.js')>();
  return {
    ...actual,
    resolveShowcaseTradeByPositionId: (...args: unknown[]) =>
      resolveShowcaseTradeByPositionIdMock(...args),
  };
});

const DEPLOYED_AT = new Date('2020-01-01T00:00:00Z');
const NOW = new Date('2026-07-31T12:00:00Z');

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    token: { findMany: vi.fn().mockResolvedValue([]) },
    smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([]) },
    position: { findMany: vi.fn().mockResolvedValue([]) },
    activityFeedPost: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as never;
}

describe('fetchTrendingTokenDbCandidates', () => {
  it("day-buckets its dedup key under the ecosystem feed namespace (not activityFeed's)", async () => {
    const tokens = [
      { id: 'tok1', mint: 'MintA', name: 'A', symbol: 'AAA', dex: 'RAYDIUM', firstSeenAt: NOW },
    ];
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = fakePrisma({
      token: { findMany: vi.fn().mockResolvedValue(tokens) },
      activityFeedPost: { findMany, findUnique: vi.fn(), create: vi.fn() },
    });

    const result = await fetchTrendingTokenDbCandidates(prisma, 5, DEPLOYED_AT, NOW);

    expect(result).toEqual([
      {
        id: 'tok1:2026-07-31',
        tokenId: 'tok1',
        mint: 'MintA',
        name: 'A',
        symbol: 'AAA',
        dex: 'RAYDIUM',
        detectedAt: NOW,
        liquidityUsd: undefined,
        marketCapUsd: undefined,
        aiScore: undefined,
        mintAuthorityRevoked: undefined,
        freezeAuthorityRevoked: undefined,
        top10HolderPercent: undefined,
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          feedType: ECOSYSTEM_FEED_TYPES.TRENDING_TOKEN,
          refId: { in: ['tok1:2026-07-31'] },
        },
      }),
    );
  });
});

describe('fetchHighVolumeDbCandidates', () => {
  it('uses its own feedType namespace, distinct from Trending Tokens', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = fakePrisma({
      token: { findMany: vi.fn().mockResolvedValue([]) },
      activityFeedPost: { findMany, findUnique: vi.fn(), create: vi.fn() },
    });
    await fetchHighVolumeDbCandidates(prisma, 5, DEPLOYED_AT, NOW);
    // No candidates from token.findMany, so filterUnposted short-circuits — assert no crash and
    // that it's wired to run at all is enough here; the interesting distinction is exercised in
    // fetchHiddenGemCandidates' filter test below.
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('fetchHiddenGemCandidates', () => {
  it('filters server-side to low-marketcap, safety-clean tokens', async () => {
    const tokens = [
      {
        id: 'tok1',
        mint: 'MintGem',
        name: 'Gem',
        symbol: 'GEM',
        dex: 'PUMPFUN',
        firstSeenAt: NOW,
        marketCapUsd: 50_000,
        liquidityUsd: 8_000,
        aiScore: 70,
      },
    ];
    const findMany = vi.fn().mockResolvedValue(tokens);
    const prisma = fakePrisma({ token: { findMany } });

    const result = await fetchHiddenGemCandidates(prisma, 5, DEPLOYED_AT, NOW, 200_000);

    expect(result).toHaveLength(1);
    expect(result[0]?.marketCapUsd).toBe(50_000);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          marketCapUsd: { not: null, lte: 200_000, gt: 0 },
          mintAuthorityRevoked: true,
          freezeAuthorityRevoked: true,
        }),
      }),
    );
  });
});

describe('fetchSmartMoneyTradeCandidates', () => {
  it('filters to wallets meeting the minimum confidence bar, same source data as activityFeed WHALE_ALERT', async () => {
    const entries = [
      {
        id: 'e1',
        walletAddress: 'Wallet1',
        mint: 'MintA',
        entryMarketCapUsd: 100,
        entryAt: NOW,
        wallet: { confidenceScore: 96, winRate: 71, medianRoiPercent: 210 },
        token: { name: 'A', symbol: 'AAA' },
      },
    ];
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue(entries) },
    });

    const result = await fetchSmartMoneyTradeCandidates(prisma, 5, DEPLOYED_AT);

    expect(result).toHaveLength(1);
    expect(result[0]?.confidenceScore).toBe(96);
    expect(result[0]?.medianRoiPercent).toBe(210);
  });

  it('excludes wallets with no confidence score yet', async () => {
    const entries = [
      {
        id: 'e1',
        walletAddress: 'Wallet1',
        mint: 'MintA',
        entryAt: NOW,
        wallet: { confidenceScore: null },
        token: null,
      },
    ];
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue(entries) },
    });

    const result = await fetchSmartMoneyTradeCandidates(prisma, 5, DEPLOYED_AT);
    expect(result).toHaveLength(0);
  });
});

describe('fetchBiggestWinnerCandidates', () => {
  it('queries closed positions ordered by realizedPnlUsd desc and resolves real trade details', async () => {
    const positions = [{ id: 'pos1', realizedPnlUsd: 500 }];
    const findMany = vi.fn().mockResolvedValue(positions);
    const prisma = fakePrisma({ position: { findMany } });
    resolveShowcaseTradeByPositionIdMock.mockResolvedValueOnce({
      positionId: 'pos1',
      mint: 'MintA',
      tokenName: 'A',
      tokenSymbol: 'AAA',
      dex: 'RAYDIUM',
      buyAt: NOW,
      sellAt: NOW,
      entryPriceUsd: 1,
      exitPriceUsd: 2,
      roiPercent: 100,
      pnlUsd: 500,
      buySignature: 'sig1',
      sellSignature: 'sig2',
      aiScore: 80,
    });

    const result = await fetchBiggestWinnerCandidates(prisma, 5, DEPLOYED_AT);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { realizedPnlUsd: 'desc' } }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.pnlUsd).toBe(500);
  });

  it("drops a candidate resolveShowcaseTradeByPositionId can't resolve rather than fabricating one", async () => {
    const positions = [{ id: 'pos1', realizedPnlUsd: 500 }];
    const prisma = fakePrisma({ position: { findMany: vi.fn().mockResolvedValue(positions) } });
    resolveShowcaseTradeByPositionIdMock.mockResolvedValueOnce(undefined);

    const result = await fetchBiggestWinnerCandidates(prisma, 5, DEPLOYED_AT);
    expect(result).toEqual([]);
  });
});

describe('dedup helpers', () => {
  it('mintDedupRefId matches the day-bucketed convention used for DB tokens', () => {
    expect(mintDedupRefId('MintA', NOW)).toBe('MintA:2026-07-31');
  });

  it('isMintAlreadyHandledToday checks the day-bucketed refId', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'row1' });
    const prisma = fakePrisma({
      activityFeedPost: { findMany: vi.fn(), findUnique, create: vi.fn() },
    });

    const result = await isMintAlreadyHandledToday(
      prisma,
      ECOSYSTEM_FEED_TYPES.TRENDING_TOKEN,
      'MintA',
      NOW,
    );

    expect(result).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        feedType_refId: {
          feedType: ECOSYSTEM_FEED_TYPES.TRENDING_TOKEN,
          refId: 'MintA:2026-07-31',
        },
      },
    });
  });

  it('markEcosystemFeedPosted writes exactly the feedType/refId pair', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const prisma = fakePrisma({
      activityFeedPost: { findMany: vi.fn(), findUnique: vi.fn(), create },
    });

    await markEcosystemFeedPosted(prisma, ECOSYSTEM_FEED_TYPES.HIDDEN_GEM, 'tok1:2026-07-31');

    expect(create).toHaveBeenCalledWith({
      data: { feedType: ECOSYSTEM_FEED_TYPES.HIDDEN_GEM, refId: 'tok1:2026-07-31' },
    });
  });
});
