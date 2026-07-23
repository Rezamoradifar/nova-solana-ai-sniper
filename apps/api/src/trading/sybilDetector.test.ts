import { describe, it, expect } from 'vitest';
import {
  groupBySharedFundingSource,
  scoreClusterSuspicion,
  clusterIdForFundingSource,
  type WalletFundingInfo,
  type WalletTimingInfo,
} from './sybilDetector.js';

describe('groupBySharedFundingSource', () => {
  it('groups wallets sharing the same resolved funding source', () => {
    const wallets: WalletFundingInfo[] = [
      { walletAddress: 'A', fundingSource: 'Funder1' },
      { walletAddress: 'B', fundingSource: 'Funder1' },
      { walletAddress: 'C', fundingSource: 'Funder2' },
    ];
    const groups = groupBySharedFundingSource(wallets);
    expect(groups.size).toBe(2);
    const funder1Cluster = groups.get(clusterIdForFundingSource('Funder1'));
    expect(funder1Cluster).toEqual(['A', 'B']);
  });

  it('never groups wallets with no resolved funding source together', () => {
    const wallets: WalletFundingInfo[] = [{ walletAddress: 'A' }, { walletAddress: 'B' }];
    const groups = groupBySharedFundingSource(wallets);
    expect(groups.size).toBe(0);
  });

  it('is deterministic across calls for the same funding source', () => {
    expect(clusterIdForFundingSource('Funder1')).toBe(clusterIdForFundingSource('Funder1'));
    expect(clusterIdForFundingSource('Funder1')).not.toBe(clusterIdForFundingSource('Funder2'));
  });
});

describe('scoreClusterSuspicion', () => {
  it('returns 0 for a single wallet (not a cluster)', () => {
    const cluster: WalletTimingInfo[] = [{ walletAddress: 'A', buyTimestampMs: 0 }];
    expect(scoreClusterSuspicion(cluster)).toBe(0);
  });

  it('scores higher for a larger group sharing a funding source', () => {
    const small: WalletTimingInfo[] = [
      { walletAddress: 'A', buyTimestampMs: 0 },
      { walletAddress: 'B', buyTimestampMs: 100_000 },
    ];
    const large: WalletTimingInfo[] = [
      { walletAddress: 'A', buyTimestampMs: 0 },
      { walletAddress: 'B', buyTimestampMs: 200_000 },
      { walletAddress: 'C', buyTimestampMs: 400_000 },
      { walletAddress: 'D', buyTimestampMs: 600_000 },
    ];
    expect(scoreClusterSuspicion(large)).toBeGreaterThan(scoreClusterSuspicion(small));
  });

  it('scores higher for tight buy timing than spread-out timing', () => {
    const tight: WalletTimingInfo[] = [
      { walletAddress: 'A', buyTimestampMs: 0 },
      { walletAddress: 'B', buyTimestampMs: 2000 },
    ];
    const spread: WalletTimingInfo[] = [
      { walletAddress: 'A', buyTimestampMs: 0 },
      { walletAddress: 'B', buyTimestampMs: 30 * 60 * 1000 },
    ];
    expect(scoreClusterSuspicion(tight)).toBeGreaterThan(scoreClusterSuspicion(spread));
  });

  it('scores higher for near-identical buy amounts than varied ones', () => {
    const identical: WalletTimingInfo[] = [
      { walletAddress: 'A', buyTimestampMs: 0, buyAmountSol: 1.0 },
      { walletAddress: 'B', buyTimestampMs: 200_000, buyAmountSol: 1.001 },
    ];
    const varied: WalletTimingInfo[] = [
      { walletAddress: 'A', buyTimestampMs: 0, buyAmountSol: 0.1 },
      { walletAddress: 'B', buyTimestampMs: 200_000, buyAmountSol: 5.0 },
    ];
    expect(scoreClusterSuspicion(identical)).toBeGreaterThan(scoreClusterSuspicion(varied));
  });

  it('never exceeds 100', () => {
    const cluster: WalletTimingInfo[] = Array.from({ length: 10 }, (_, i) => ({
      walletAddress: `wallet${i}`,
      buyTimestampMs: i * 100,
      buyAmountSol: 1.0,
    }));
    expect(scoreClusterSuspicion(cluster)).toBeLessThanOrEqual(100);
  });
});
