import { describe, expect, it, vi } from 'vitest';
import {
  fetchNetworkTradeCandidates,
  markNetworkTradePosted,
  categorizeNetworkTrade,
  isNetworkTradeCandidateEligible,
  computeNetworkTradePriorityTier,
  compareNetworkTradeCandidatesByPriority,
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
    wallet: { confidenceScore: 65, rugExposureRatePct: 5, sybilConfidencePct: 0 },
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
        walletRugExposureRatePct: 5,
        walletSybilConfidencePct: 0,
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

describe('isNetworkTradeCandidateEligible', () => {
  it('accepts a profitable trade', () => {
    expect(
      isNetworkTradeCandidateEligible({
        realizedRoiPercent: 80,
        walletRugExposureRatePct: 0,
        walletSybilConfidencePct: 0,
      }),
    ).toBe(true);
  });

  it('accepts a small loss', () => {
    expect(
      isNetworkTradeCandidateEligible({
        realizedRoiPercent: -15,
        walletRugExposureRatePct: 0,
        walletSybilConfidencePct: 0,
      }),
    ).toBe(true);
  });

  it('skips a loss steep enough to read as a rug (worse than -30%)', () => {
    expect(
      isNetworkTradeCandidateEligible({
        realizedRoiPercent: -85,
        walletRugExposureRatePct: 0,
        walletSybilConfidencePct: 0,
      }),
    ).toBe(false);
  });

  it('skips a wallet with a high historical rug-exposure rate even on a winning trade', () => {
    expect(
      isNetworkTradeCandidateEligible({
        realizedRoiPercent: 100,
        walletRugExposureRatePct: 75,
        walletSybilConfidencePct: 0,
      }),
    ).toBe(false);
  });

  it('skips a wallet flagged as a likely Sybil/wash-trading cluster', () => {
    expect(
      isNetworkTradeCandidateEligible({
        realizedRoiPercent: 100,
        walletRugExposureRatePct: 0,
        walletSybilConfidencePct: 90,
      }),
    ).toBe(false);
  });

  it('treats an unscored wallet (undefined rug/Sybil signals) as clean, not a crash', () => {
    expect(() =>
      isNetworkTradeCandidateEligible({
        realizedRoiPercent: 50,
        walletRugExposureRatePct: undefined,
        walletSybilConfidencePct: undefined,
      }),
    ).not.toThrow();
  });
});

describe('computeNetworkTradePriorityTier', () => {
  const base = {
    realizedRoiPercent: 10,
    realizedPnlUsd: 10,
    walletConfidenceScore: 0,
    entryAmountSol: 0.1,
    volume24hUsd: 0,
    priceChangeH1Percent: 0,
  };

  it('tags a high-volume token tier 1 (Trending Tokens) regardless of other signals', () => {
    expect(computeNetworkTradePriorityTier({ ...base, volume24hUsd: 150_000 })).toBe(1);
  });

  it('tags a large hourly move tier 1 (Trending Tokens) even with low volume', () => {
    expect(computeNetworkTradePriorityTier({ ...base, priceChangeH1Percent: -35 })).toBe(1);
  });

  it('tags a high-confidence wallet tier 2 (Smart Money) when not trending', () => {
    expect(computeNetworkTradePriorityTier({ ...base, walletConfidenceScore: 75 })).toBe(2);
  });

  it('tags a large real entry tier 3 (Whale Wallets) when neither trending nor smart money', () => {
    expect(computeNetworkTradePriorityTier({ ...base, entryAmountSol: 8 })).toBe(3);
  });

  it('falls back to tier 4 when no category signal clears its bar', () => {
    expect(computeNetworkTradePriorityTier(base)).toBe(4);
  });

  it('prioritizes Trending over Smart Money and Whale when all three qualify', () => {
    expect(
      computeNetworkTradePriorityTier({
        ...base,
        volume24hUsd: 500_000,
        walletConfidenceScore: 90,
        entryAmountSol: 10,
      }),
    ).toBe(1);
  });

  it('prioritizes Smart Money over Whale when both qualify but not Trending', () => {
    expect(
      computeNetworkTradePriorityTier({ ...base, walletConfidenceScore: 90, entryAmountSol: 10 }),
    ).toBe(2);
  });
});

describe('compareNetworkTradeCandidatesByPriority', () => {
  const base = {
    realizedRoiPercent: 10,
    realizedPnlUsd: 10,
    walletConfidenceScore: 0,
    entryAmountSol: 0.1,
    volume24hUsd: 0,
    priceChangeH1Percent: 0,
  };

  it('ranks a Trending candidate above a Smart Money candidate regardless of ROI/PnL', () => {
    const trending = { ...base, volume24hUsd: 500_000, realizedRoiPercent: 1, realizedPnlUsd: 1 };
    const smartMoney = { ...base, walletConfidenceScore: 90, realizedRoiPercent: 1000 };
    const sorted = [smartMoney, trending].sort(compareNetworkTradeCandidatesByPriority);
    expect(sorted[0]).toBe(trending);
  });

  it('within the same tier, ranks Highest ROI first', () => {
    const higherRoi = { ...base, realizedRoiPercent: 300, realizedPnlUsd: 10 };
    const lowerRoi = { ...base, realizedRoiPercent: 20, realizedPnlUsd: 5000 };
    const sorted = [lowerRoi, higherRoi].sort(compareNetworkTradeCandidatesByPriority);
    expect(sorted[0]).toBe(higherRoi);
  });

  it('uses Highest PnL as the final tie-break when ROI ties', () => {
    const higherPnl = { ...base, realizedRoiPercent: 50, realizedPnlUsd: 900 };
    const lowerPnl = { ...base, realizedRoiPercent: 50, realizedPnlUsd: 100 };
    const sorted = [lowerPnl, higherPnl].sort(compareNetworkTradeCandidatesByPriority);
    expect(sorted[0]).toBe(higherPnl);
  });
});

describe('categorizeNetworkTrade', () => {
  const base = { entryAmountSol: 0.1 };

  it('tags a high-confidence wallet SMART_MONEY even when the token has no trending signal', () => {
    expect(
      categorizeNetworkTrade({
        ...base,
        realizedPnlUsd: 100,
        walletConfidenceScore: 75,
        volume24hUsd: 0,
        priceChangeH1Percent: 0,
      }),
    ).toBe('SMART_MONEY');
  });

  it('tags a large real entry WHALE_WALLET when neither trending nor smart money', () => {
    expect(
      categorizeNetworkTrade({
        realizedPnlUsd: 100,
        walletConfidenceScore: 0,
        volume24hUsd: 0,
        priceChangeH1Percent: 0,
        entryAmountSol: 8,
      }),
    ).toBe('WHALE_WALLET');
  });

  it('tags a high-volume token TRENDING_TOKEN when the wallet has no track record', () => {
    expect(
      categorizeNetworkTrade({
        ...base,
        realizedPnlUsd: 100,
        walletConfidenceScore: undefined,
        volume24hUsd: 150_000,
        priceChangeH1Percent: 0,
      }),
    ).toBe('TRENDING_TOKEN');
  });

  it('tags a large hourly move TRENDING_TOKEN even with low volume', () => {
    expect(
      categorizeNetworkTrade({
        ...base,
        realizedPnlUsd: -100,
        walletConfidenceScore: undefined,
        volume24hUsd: 0,
        priceChangeH1Percent: -35,
      }),
    ).toBe('TRENDING_TOKEN');
  });

  it('falls back to NETWORK_PROFIT/NETWORK_LOSS by sign when no category signal clears its bar', () => {
    expect(
      categorizeNetworkTrade({
        ...base,
        realizedPnlUsd: 50,
        walletConfidenceScore: 10,
        volume24hUsd: 500,
        priceChangeH1Percent: 2,
      }),
    ).toBe('NETWORK_PROFIT');
    expect(
      categorizeNetworkTrade({
        ...base,
        realizedPnlUsd: -50,
        walletConfidenceScore: 10,
        volume24hUsd: 500,
        priceChangeH1Percent: 2,
      }),
    ).toBe('NETWORK_LOSS');
  });

  it('prioritizes TRENDING_TOKEN over SMART_MONEY and WHALE_WALLET when all three qualify', () => {
    expect(
      categorizeNetworkTrade({
        realizedPnlUsd: 100,
        walletConfidenceScore: 90,
        volume24hUsd: 500_000,
        priceChangeH1Percent: 50,
        entryAmountSol: 10,
      }),
    ).toBe('TRENDING_TOKEN');
  });

  it('prioritizes SMART_MONEY over WHALE_WALLET when both qualify but not TRENDING_TOKEN', () => {
    expect(
      categorizeNetworkTrade({
        realizedPnlUsd: 100,
        walletConfidenceScore: 90,
        volume24hUsd: 0,
        priceChangeH1Percent: 0,
        entryAmountSol: 10,
      }),
    ).toBe('SMART_MONEY');
  });
});
