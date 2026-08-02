import { describe, it, expect } from 'vitest';
import {
  computeWalletConfidence,
  detectClusterBuy,
  computeSmartMoneyScore,
  applySybilDiscount,
  extractBuyerFromTransaction,
  extractSellFromTransaction,
  computeExitPnl,
  MIN_SAMPLE_SIZE_FOR_CONFIDENCE,
  type WalletEntrySummary,
  type WalletBuyEvent,
} from './smartWalletTracker.js';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';

function entry(overrides: Partial<WalletEntrySummary> = {}): WalletEntrySummary {
  return {
    entryAt: new Date(),
    status: 'EXITED',
    realizedRoiPercent: 50,
    isRugOrScam: false,
    ...overrides,
  };
}

describe('computeWalletConfidence', () => {
  it('never scores confidence from fewer than MIN_SAMPLE_SIZE_FOR_CONFIDENCE resolved entries', () => {
    const entries = Array.from({ length: MIN_SAMPLE_SIZE_FOR_CONFIDENCE - 1 }, () => entry());
    const result = computeWalletConfidence(entries, Date.now());
    expect(result.confidenceScore).toBeUndefined();
    expect(result.sampleSize).toBe(MIN_SAMPLE_SIZE_FOR_CONFIDENCE - 1);
  });

  it('excludes OPEN entries from sampleSize even when there are many', () => {
    const entries = [
      ...Array.from({ length: 10 }, () => entry({ status: 'OPEN' })),
      entry({ status: 'EXITED' }),
    ];
    const result = computeWalletConfidence(entries, Date.now());
    expect(result.sampleSize).toBe(1);
    expect(result.confidenceScore).toBeUndefined();
  });

  it('produces a real confidence score once the sample-size threshold is met', () => {
    const entries = Array.from({ length: MIN_SAMPLE_SIZE_FOR_CONFIDENCE }, () =>
      entry({ realizedRoiPercent: 100, entryAt: new Date() }),
    );
    const result = computeWalletConfidence(entries, Date.now());
    expect(result.confidenceScore).toBeGreaterThan(0);
    expect(result.sampleSize).toBe(MIN_SAMPLE_SIZE_FOR_CONFIDENCE);
    expect(result.medianRoiPercent).toBe(100);
  });

  it('heavily penalizes a high rug-exposure rate', () => {
    const now = Date.now();
    const goodEntries = Array.from({ length: 5 }, () =>
      entry({ realizedRoiPercent: 100, entryAt: new Date(now), isRugOrScam: false }),
    );
    const rugEntries = Array.from({ length: 5 }, () =>
      entry({ realizedRoiPercent: 100, entryAt: new Date(now), isRugOrScam: true }),
    );
    const goodResult = computeWalletConfidence(goodEntries, now);
    const rugResult = computeWalletConfidence(rugEntries, now);
    expect(rugResult.confidenceScore!).toBeLessThan(goodResult.confidenceScore!);
  });

  it('dampens (but does not zero out) confidence for stale activity', () => {
    const now = Date.now();
    const recent = Array.from({ length: 5 }, () =>
      entry({ realizedRoiPercent: 80, entryAt: new Date(now) }),
    );
    const stale = Array.from({ length: 5 }, () =>
      entry({ realizedRoiPercent: 80, entryAt: new Date(now - 365 * 24 * 60 * 60 * 1000) }),
    );
    const recentResult = computeWalletConfidence(recent, now);
    const staleResult = computeWalletConfidence(stale, now);
    expect(staleResult.confidenceScore!).toBeLessThan(recentResult.confidenceScore!);
    expect(staleResult.confidenceScore!).toBeGreaterThan(0);
  });

  it('counts entries within the early-entry window toward earlyEntryRatePct', () => {
    const entries = Array.from({ length: 5 }, () =>
      entry({ realizedRoiPercent: 50, secondsAfterPoolCreation: 60 }),
    );
    const result = computeWalletConfidence(entries, Date.now());
    expect(result.earlyEntryRatePct).toBe(100);
  });

  it('uses unrealizedRoiPercent as the outcome proxy for EXPIRED/RUG_FLAGGED entries', () => {
    const entries = Array.from({ length: 5 }, () =>
      entry({ status: 'EXPIRED', realizedRoiPercent: undefined, unrealizedRoiPercent: -30 }),
    );
    const result = computeWalletConfidence(entries, Date.now());
    expect(result.medianRoiPercent).toBe(-30);
  });
});

describe('detectClusterBuy', () => {
  const t0 = 1_000_000;

  it('requires the minimum number of independent wallets above the confidence floor', () => {
    const buys: WalletBuyEvent[] = [{ walletAddress: 'A', confidenceScore: 70, timestampMs: t0 }];
    const result = detectClusterBuy(buys);
    expect(result.isClusterBuy).toBe(false);
    expect(result.independentClusterCount).toBe(1);
  });

  it('detects a genuine cluster buy from independent high-confidence wallets within the window', () => {
    const buys: WalletBuyEvent[] = [
      { walletAddress: 'A', confidenceScore: 70, timestampMs: t0 },
      { walletAddress: 'B', confidenceScore: 80, timestampMs: t0 + 60_000 },
      { walletAddress: 'C', confidenceScore: 90, timestampMs: t0 + 120_000 },
    ];
    const result = detectClusterBuy(buys);
    expect(result.isClusterBuy).toBe(true);
    expect(result.independentClusterCount).toBe(3);
  });

  it('ignores low-confidence wallets entirely', () => {
    const buys: WalletBuyEvent[] = [
      { walletAddress: 'A', confidenceScore: 10, timestampMs: t0 },
      { walletAddress: 'B', confidenceScore: 20, timestampMs: t0 + 1000 },
    ];
    const result = detectClusterBuy(buys);
    expect(result.isClusterBuy).toBe(false);
    expect(result.independentClusterCount).toBe(0);
  });

  it('collapses wallets sharing a sybilClusterId into a single independent unit', () => {
    const buys: WalletBuyEvent[] = [
      { walletAddress: 'A', confidenceScore: 90, sybilClusterId: 'ring1', timestampMs: t0 },
      { walletAddress: 'B', confidenceScore: 90, sybilClusterId: 'ring1', timestampMs: t0 + 1000 },
      { walletAddress: 'C', confidenceScore: 90, sybilClusterId: 'ring1', timestampMs: t0 + 2000 },
    ];
    const result = detectClusterBuy(buys);
    expect(result.isClusterBuy).toBe(false);
    expect(result.independentClusterCount).toBe(1);
  });

  it('respects the time window boundary — buys outside the window never join the same cluster', () => {
    const buys: WalletBuyEvent[] = [
      { walletAddress: 'A', confidenceScore: 90, timestampMs: t0 },
      { walletAddress: 'B', confidenceScore: 90, timestampMs: t0 + 10 * 60 * 1000 },
    ];
    const result = detectClusterBuy(buys, 5 * 60 * 1000);
    expect(result.isClusterBuy).toBe(false);
    expect(result.independentClusterCount).toBe(1);
  });
});

describe('computeSmartMoneyScore', () => {
  it('returns 0 for no buys', () => {
    expect(
      computeSmartMoneyScore([], {
        isClusterBuy: false,
        independentClusterCount: 0,
        clusterKeys: [],
      }),
    ).toBe(0);
  });

  it('scales with confidence and gets a bonus for a real cluster buy', () => {
    const single: WalletBuyEvent[] = [{ walletAddress: 'A', confidenceScore: 80, timestampMs: 0 }];
    const singleScore = computeSmartMoneyScore(single, {
      isClusterBuy: false,
      independentClusterCount: 1,
      clusterKeys: ['A'],
    });

    const clustered: WalletBuyEvent[] = [
      { walletAddress: 'A', confidenceScore: 80, timestampMs: 0 },
      { walletAddress: 'B', confidenceScore: 80, timestampMs: 1000 },
    ];
    const clusterScore = computeSmartMoneyScore(clustered, {
      isClusterBuy: true,
      independentClusterCount: 2,
      clusterKeys: ['A', 'B'],
    });

    expect(clusterScore).toBeGreaterThan(singleScore);
    expect(clusterScore).toBeLessThanOrEqual(100);
  });
});

describe('applySybilDiscount', () => {
  it('discounts confidence multiplicatively without hard-excluding the wallet', () => {
    const buys: WalletBuyEvent[] = [{ walletAddress: 'A', confidenceScore: 80, timestampMs: 0 }];
    const discounted = applySybilDiscount(buys, new Map([['A', 50]]));
    expect(discounted[0]!.confidenceScore).toBe(40);
  });

  it('leaves wallets with no resolved sybil suspicion untouched', () => {
    const buys: WalletBuyEvent[] = [{ walletAddress: 'A', confidenceScore: 80, timestampMs: 0 }];
    const discounted = applySybilDiscount(buys, new Map());
    expect(discounted[0]!.confidenceScore).toBe(80);
  });
});

function fakeParsedTx(overrides: {
  feePayer: string;
  mint: string;
  preAmount?: number;
  postAmount?: number;
  owner?: string;
  otherAccounts?: string[];
  /** Native lamport balances indexed exactly like accountKeys
   * ([feePayer, ...otherAccounts]) — omit entirely to simulate a parsed tx
   * with no balance data at all. */
  preBalances?: number[];
  postBalances?: number[];
}): ParsedTransactionWithMeta {
  const {
    feePayer,
    mint,
    preAmount = 0,
    postAmount = 0,
    owner = feePayer,
    otherAccounts = [],
    preBalances,
    postBalances,
  } = overrides;
  return {
    transaction: {
      message: {
        accountKeys: [
          { pubkey: { toBase58: () => feePayer } },
          ...otherAccounts.map((a) => ({ pubkey: { toBase58: () => a } })),
        ],
      },
    },
    meta: {
      preTokenBalances: [{ mint, owner, uiTokenAmount: { uiAmount: preAmount } }],
      postTokenBalances: [{ mint, owner, uiTokenAmount: { uiAmount: postAmount } }],
      preBalances,
      postBalances,
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe('extractBuyerFromTransaction', () => {
  const mint = 'MintAddress111';

  it('returns the fee payer and positive delta when their balance increased', () => {
    const tx = fakeParsedTx({ feePayer: 'Buyer1', mint, preAmount: 0, postAmount: 1000 });
    const result = extractBuyerFromTransaction(tx, mint);
    expect(result).toEqual({ walletAddress: 'Buyer1', amountTokenUi: 1000 });
  });

  it('returns undefined when the fee payer balance decreased (a sell, not a buy)', () => {
    const tx = fakeParsedTx({ feePayer: 'Seller1', mint, preAmount: 1000, postAmount: 200 });
    expect(extractBuyerFromTransaction(tx, mint)).toBeUndefined();
  });

  it('returns undefined when there is no token balance change for this mint at all', () => {
    const tx = fakeParsedTx({ feePayer: 'Nobody', mint: 'OtherMint', preAmount: 0, postAmount: 0 });
    expect(extractBuyerFromTransaction(tx, mint)).toBeUndefined();
  });

  it('resolves the real on-chain SOL spent from the fee payer native balance delta', () => {
    const tx = fakeParsedTx({
      feePayer: 'Buyer1',
      mint,
      preAmount: 0,
      postAmount: 1000,
      preBalances: [2_000_000_000],
      postBalances: [1_000_000_000],
    });
    const result = extractBuyerFromTransaction(tx, mint);
    expect(result?.amountSol).toBe(1);
  });

  it('leaves amountSol undefined when balance arrays are missing rather than guessing', () => {
    const tx = fakeParsedTx({ feePayer: 'Buyer1', mint, preAmount: 0, postAmount: 1000 });
    expect(extractBuyerFromTransaction(tx, mint)?.amountSol).toBeUndefined();
  });
});

describe('extractSellFromTransaction', () => {
  const mint = 'MintAddress111';

  it('returns the sold amount and real SOL received for a full exit', () => {
    const tx = fakeParsedTx({
      feePayer: 'Relayer',
      owner: 'Seller1',
      mint,
      preAmount: 1000,
      postAmount: 0,
      otherAccounts: ['Seller1'],
      // index 0 = Relayer (fee payer, irrelevant here), index 1 = Seller1.
      preBalances: [5_000_000_000, 1_000_000_000],
      postBalances: [4_999_995_000, 1_500_000_000],
    });
    const result = extractSellFromTransaction(tx, mint, 'Seller1');
    expect(result).toEqual({ amountTokenUi: 1000, amountSol: 0.5 });
  });

  it('returns undefined for a partial sell below FULL_EXIT_MIN_SOLD_FRACTION', () => {
    const tx = fakeParsedTx({
      feePayer: 'Seller1',
      mint,
      preAmount: 1000,
      postAmount: 500, // only 50% sold
    });
    expect(extractSellFromTransaction(tx, mint, 'Seller1')).toBeUndefined();
  });

  it('returns undefined when the wallet never held this mint', () => {
    const tx = fakeParsedTx({ feePayer: 'Seller1', mint, preAmount: 0, postAmount: 0 });
    expect(extractSellFromTransaction(tx, mint, 'Seller1')).toBeUndefined();
  });

  it('leaves amountSol undefined when the wallet is not in accountKeys at all', () => {
    const tx = fakeParsedTx({
      feePayer: 'Relayer',
      owner: 'Seller1',
      mint,
      preAmount: 1000,
      postAmount: 0,
    });
    const result = extractSellFromTransaction(tx, mint, 'Seller1');
    expect(result).toEqual({ amountTokenUi: 1000, amountSol: undefined });
  });
});

describe('computeExitPnl', () => {
  it('computes SOL-native PnL/ROI from real SOL in vs real SOL out, never from price', () => {
    const result = computeExitPnl(1, { amountTokenUi: 1000, amountSol: 1.5 });
    expect(result).toEqual({ realizedPnlSol: 0.5, realizedRoiPercent: 50 });
  });

  it('reports a real loss when less SOL came back out than went in', () => {
    const result = computeExitPnl(2, { amountTokenUi: 1000, amountSol: 0.2 });
    expect(result).toEqual({ realizedPnlSol: -1.8, realizedRoiPercent: -90 });
  });

  it('returns undefined when entryAmountSol was never captured (an older entry)', () => {
    expect(computeExitPnl(null, { amountTokenUi: 1000, amountSol: 1.5 })).toBeUndefined();
  });

  it('returns undefined when the sell itself has no resolvable SOL amount', () => {
    expect(computeExitPnl(1, { amountTokenUi: 1000, amountSol: undefined })).toBeUndefined();
  });
});
