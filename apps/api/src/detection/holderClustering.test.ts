import { describe, expect, it } from 'vitest';
import {
  analyzeHolderClustering,
  DEFAULT_HOLDER_CLUSTERING_CONFIG,
  type ClusterHolderBalance,
} from './holderClustering.js';

const TOTAL_SUPPLY = 999_927_118_046_681n; // matches the real USOH incident mint

/** 18 wallets each holding ~2,470,000 tokens (raw, 6-decimal), within a
 * fraction of a percent of each other — the exact shape found in the USOH
 * incident's top-20 holder read (positions #3-#20). */
function incidentClusterHolders(): ClusterHolderBalance[] {
  const base = 2_470_775_726_852n;
  const balances = [
    2_470_775_726_852n,
    2_470_760_194_491n,
    2_470_548_004_667n,
    2_470_306_357_378n,
    2_470_288_914_694n,
    2_470_251_881_501n,
    2_470_249_041_817n,
    2_470_219_736_282n,
    2_470_209_040_472n,
    2_470_170_302_461n,
    2_470_118_292_372n,
    2_470_065_690_601n,
    2_469_975_452_845n,
    2_469_806_890_905n,
    2_469_802_331_512n,
    2_469_785_212_971n,
    2_469_670_147_399n,
    2_469_662_661_933n,
  ];
  return balances.map((amountRaw, i) => ({ address: `ClusterWallet${i}`, amountRaw }));
}

describe('analyzeHolderClustering', () => {
  it('regression: flags the exact USOH incident holder shape as UNSAFE (18 near-identical wallets, ~4.4% of supply)', () => {
    const result = analyzeHolderClustering(
      incidentClusterHolders(),
      TOTAL_SUPPLY,
      DEFAULT_HOLDER_CLUSTERING_CONFIG,
    );
    expect(result.state).toBe('UNSAFE');
    expect(result.reasons).toContain('bundled_wallet_cluster_detected');
    expect(result.largestClusterWalletCount).toBe(18);
    expect(result.largestClusterSupplyPercent).toBeGreaterThan(4);
    expect(result.largestClusterSupplyPercent).toBeLessThan(5);
  });

  it('reports SAFE for organically-varied holder balances (a real, non-bundled distribution)', () => {
    const holders: ClusterHolderBalance[] = [
      { address: 'A', amountRaw: 50_000_000n },
      { address: 'B', amountRaw: 12_000_000n },
      { address: 'C', amountRaw: 6_500_000n },
      { address: 'D', amountRaw: 3_100_000n },
      { address: 'E', amountRaw: 900_000n },
      { address: 'F', amountRaw: 400_000n },
    ];
    const result = analyzeHolderClustering(
      holders,
      1_000_000_000n,
      DEFAULT_HOLDER_CLUSTERING_CONFIG,
    );
    expect(result.state).toBe('SAFE');
    expect(result.reasons).toEqual([]);
  });

  it('does not flag a tight cluster below the minimum wallet count (e.g. 2 friends buying at the same time)', () => {
    const holders: ClusterHolderBalance[] = [
      { address: 'A', amountRaw: 10_000_000n },
      { address: 'B', amountRaw: 9_950_000n },
      { address: 'C', amountRaw: 500_000n },
      { address: 'D', amountRaw: 100_000n },
    ];
    const result = analyzeHolderClustering(holders, 100_000_000n, DEFAULT_HOLDER_CLUSTERING_CONFIG);
    expect(result.state).toBe('SAFE');
  });

  it('does not flag a large tight cluster whose combined supply is below the minimum percent threshold', () => {
    const config = { ...DEFAULT_HOLDER_CLUSTERING_CONFIG, minClusterSupplyPercent: 50 };
    const result = analyzeHolderClustering(incidentClusterHolders(), TOTAL_SUPPLY, config);
    expect(result.state).toBe('SAFE');
  });

  it('reports UNKNOWN (not SAFE) when total supply is unresolved', () => {
    const result = analyzeHolderClustering(
      incidentClusterHolders(),
      0n,
      DEFAULT_HOLDER_CLUSTERING_CONFIG,
    );
    expect(result.state).toBe('UNKNOWN');
    expect(result.reasons).not.toContain('bundled_wallet_cluster_detected');
  });

  it('reports UNKNOWN (not SAFE) when there are no positive-balance holders to analyze', () => {
    const result = analyzeHolderClustering([], TOTAL_SUPPLY, DEFAULT_HOLDER_CLUSTERING_CONFIG);
    expect(result.state).toBe('UNKNOWN');
  });

  it('flags the creator wallet distinctly when it is a member of the detected cluster', () => {
    const holders = incidentClusterHolders();
    const result = analyzeHolderClustering(
      holders,
      TOTAL_SUPPLY,
      DEFAULT_HOLDER_CLUSTERING_CONFIG,
      {
        creatorAddress: holders[0]!.address,
      },
    );
    expect(result.state).toBe('UNSAFE');
    expect(result.reasons).toContain('creator_wallet_in_cluster');
  });

  it('does not flag creator linkage when the creator is not part of the cluster', () => {
    const result = analyzeHolderClustering(
      incidentClusterHolders(),
      TOTAL_SUPPLY,
      DEFAULT_HOLDER_CLUSTERING_CONFIG,
      { creatorAddress: 'SomeUnrelatedWallet' },
    );
    expect(result.reasons).not.toContain('creator_wallet_in_cluster');
  });

  it('flags coordinated funding only when a shared funding source is provided for 2+ cluster members (best-effort, opt-in)', () => {
    const holders = incidentClusterHolders();
    const fundingSourceByAddress: Record<string, string> = {
      [holders[0]!.address]: 'FunderX',
      [holders[1]!.address]: 'FunderX',
    };
    const result = analyzeHolderClustering(
      holders,
      TOTAL_SUPPLY,
      DEFAULT_HOLDER_CLUSTERING_CONFIG,
      {
        fundingSourceByAddress,
      },
    );
    expect(result.reasons).toContain('coordinated_wallet_funding_detected');
  });

  it('does not flag coordinated funding when no funding-source data is supplied at all (the default, live-pipeline mode)', () => {
    const result = analyzeHolderClustering(
      incidentClusterHolders(),
      TOTAL_SUPPLY,
      DEFAULT_HOLDER_CLUSTERING_CONFIG,
    );
    expect(result.reasons).not.toContain('coordinated_wallet_funding_detected');
  });

  it('ignores zero-balance holders entirely', () => {
    const holders: ClusterHolderBalance[] = [
      ...incidentClusterHolders(),
      { address: 'Empty1', amountRaw: 0n },
      { address: 'Empty2', amountRaw: 0n },
    ];
    const result = analyzeHolderClustering(holders, TOTAL_SUPPLY, DEFAULT_HOLDER_CLUSTERING_CONFIG);
    expect(result.largestClusterWalletCount).toBe(18);
  });

  it('regression (2026-07-27, USOX confirmed-scam false negative): flags the real USOX holder shape as UNSAFE — a 2026-07-27 audit briefly tightened the default tolerance to 50bps on the theory that this exact shape was organic retail convergence, which let this confirmed scam pass; must never regress back to that state', () => {
    // Reconstructed from USOX's real captured on-chain data (mint
    // FRvCZ21KnXp3oWBE92qRi4K9Gh4ms8f4mqUUMKKHPump): real total supply
    // 999,902,737,971,779 (6 decimals), a 17-wallet cluster combining to the
    // real observed 14.865768922154734% of supply, each wallet within ~1% of
    // the group average (a tight-but-not-machine-exact spread, consistent
    // with a coordinated distribution) — while top10HolderPercent (9.5%) and
    // isHoneypotSuspected (false) looked clean, this shape combined with a
    // +102,540%/24h pump and only 20 total holders across 856 recorded trades
    // (confirmed real-world: a fake "United States Oil Exchange" scam, not a
    // legitimate token).
    const totalSupply = 999_902_737_971_779n;
    const perWalletBase = 8_743_719_439_599n;
    const jitterBps = [40, -35, 60, -20, 15, -50, 30, -10, 55, -25, 5, -45, 20, -15, 65, -30, 0];
    const holders: ClusterHolderBalance[] = jitterBps.map((bps, i) => ({
      address: `USOXHolder${i}`,
      amountRaw: perWalletBase + (perWalletBase * BigInt(bps)) / 10_000n,
    }));

    const result = analyzeHolderClustering(holders, totalSupply, DEFAULT_HOLDER_CLUSTERING_CONFIG);
    expect(result.state).toBe('UNSAFE');
    expect(result.reasons).toContain('bundled_wallet_cluster_detected');
    expect(result.largestClusterWalletCount).toBe(17);
    expect(result.largestClusterSupplyPercent).toBeGreaterThan(14);
    expect(result.largestClusterSupplyPercent).toBeLessThan(16);
  });
});
