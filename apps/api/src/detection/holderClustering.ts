/**
 * Bundled-wallet / holder-clustering detection (2026-07-23, USOH incident
 * follow-up): the incident token passed every existing check
 * (criticalSecurityGate.ts's top10HolderPercent < 90% and holderCount >= 5)
 * while 18 of its top 20 holders each held an almost identical ~0.25% of
 * supply — the textbook signature of a single actor distributing supply
 * across many wallets in one bundle to defeat exactly those two checks while
 * retaining effective control. Neither existing check looks at the *shape* of
 * the distribution, only its aggregate concentration/count — this does.
 *
 * Pure and independently tested, same convention as criticalSecurityGate.ts's
 * evaluateCriticalSecurityGate. Deliberately distinguishes UNKNOWN (no/
 * insufficient holder data to judge) from UNSAFE (a cluster was actually
 * found) — see HolderClusteringState — so a data-source gap is never
 * misreported as a confirmed finding, same convention as
 * RiskFlags.holderDataUnknown.
 */
export type HolderClusteringState = 'SAFE' | 'UNSAFE' | 'UNKNOWN';

export interface ClusterHolderBalance {
  address: string;
  amountRaw: bigint;
}

export interface HolderClusteringConfig {
  /** Two holders are considered part of the same near-identical cluster when
   * they differ by less than this, relative to the larger balance (basis
   * points; 300 = 3%). A real, organically-traded token's holder balances are
   * essentially never this tightly banded across 4+ independent wallets —
   * only a single distribution transaction produces that. */
  similarityToleranceBps: number;
  /** A tight cluster smaller than this many wallets is not, on its own,
   * unusual (e.g. two friends who bought at the same time). */
  minClusterWalletCount: number;
  /** A tight cluster below this % of total supply isn't worth blocking a buy
   * over even if the wallet count is met — this bounds how much of the
   * token's economics that single distribution could plausibly control. */
  minClusterSupplyPercent: number;
}

/** Calibrated against the USOH incident's actual holder data: 18 wallets each
 * within ~0.05% of each other, combining to ~4.45% of supply. Comfortably
 * inside these defaults (3% similarity band, 4+ wallets, 3%+ of supply) while
 * still requiring genuine multi-wallet, near-identical concentration — not
 * just "two wallets happen to hold similar amounts." */
export const DEFAULT_HOLDER_CLUSTERING_CONFIG: HolderClusteringConfig = {
  similarityToleranceBps: 300,
  minClusterWalletCount: 4,
  minClusterSupplyPercent: 3,
};

export interface HolderClusteringResult {
  state: HolderClusteringState;
  /** Empty when SAFE. Never empty when UNSAFE/UNKNOWN. */
  reasons: string[];
  largestClusterWalletCount: number;
  largestClusterSupplyPercent: number;
}

function relativeDiffBps(base: bigint, other: bigint): number {
  if (base <= 0n) return 10_000;
  const diff = base > other ? base - other : other - base;
  return Number((diff * 10_000n) / base);
}

/**
 * Detects the largest tight-balance cluster among `holders` (already expected
 * to exclude known pool/vault addresses — see onchain.ts's
 * getHolderConcentration), and optionally flags when a known creator/deployer
 * address is itself a member of that cluster.
 *
 * Coordinated wallet funding (2026-07-23 requirement: "where detectable") is
 * intentionally NOT traced here by default — confirming a shared SOL funding
 * source for a cluster of wallets requires per-wallet transaction-history RPC
 * calls (getSignaturesForAddress + parsed tx per holder), which is exactly
 * the kind of unbounded per-candidate RPC cost that caused the Telegram-
 * source RPC-quota incident (see project memory). `fundingSourceByAddress` is
 * an optional best-effort hook: a caller that HAS already resolved funding
 * sources for these specific addresses (e.g. a future, rate-limited background
 * job) can pass them in and get a distinct 'coordinated_wallet_funding_detected'
 * reason; omitted (the default, and the only mode wired into the live pipeline
 * today) simply skips that one check rather than guessing.
 */
export function analyzeHolderClustering(
  holders: ClusterHolderBalance[],
  totalSupplyRaw: bigint,
  config: HolderClusteringConfig,
  options?: {
    creatorAddress?: string;
    fundingSourceByAddress?: Record<string, string | undefined>;
  },
): HolderClusteringResult {
  if (totalSupplyRaw <= 0n) {
    return {
      state: 'UNKNOWN',
      reasons: ['holder_clustering_supply_unknown'],
      largestClusterWalletCount: 0,
      largestClusterSupplyPercent: 0,
    };
  }

  const positive = holders
    .filter((h) => h.amountRaw > 0n)
    .sort((a, b) => (a.amountRaw < b.amountRaw ? 1 : a.amountRaw > b.amountRaw ? -1 : 0));

  if (positive.length === 0) {
    return {
      state: 'UNKNOWN',
      reasons: ['holder_clustering_data_unavailable'],
      largestClusterWalletCount: 0,
      largestClusterSupplyPercent: 0,
    };
  }

  const totalSupply = Number(totalSupplyRaw);

  // Sliding window over balances sorted descending: for each start index, the
  // window's reference balance is positive[i] (the largest in the window), so
  // it only ever needs to check candidates *below* it for the relative-diff
  // tolerance. O(n^2) but n is capped at 20 (getTokenLargestAccounts' own
  // limit), so this is trivially cheap.
  let bestStart = 0;
  let bestEnd = 0; // exclusive
  let bestSupplyRaw = 0n;

  for (let i = 0; i < positive.length; i++) {
    let j = i;
    while (
      j + 1 < positive.length &&
      relativeDiffBps(positive[i]!.amountRaw, positive[j + 1]!.amountRaw) <=
        config.similarityToleranceBps
    ) {
      j++;
    }
    let windowSupplyRaw = 0n;
    for (let k = i; k <= j; k++) windowSupplyRaw += positive[k]!.amountRaw;
    if (windowSupplyRaw > bestSupplyRaw) {
      bestSupplyRaw = windowSupplyRaw;
      bestStart = i;
      bestEnd = j + 1;
    }
  }

  const bestCluster = positive.slice(bestStart, bestEnd);
  const largestClusterWalletCount = bestCluster.length;
  const largestClusterSupplyPercent = (Number(bestSupplyRaw) / totalSupply) * 100;

  const reasons: string[] = [];
  let state: HolderClusteringState = 'SAFE';

  const clusterIsSuspicious =
    largestClusterWalletCount >= config.minClusterWalletCount &&
    largestClusterSupplyPercent >= config.minClusterSupplyPercent;

  if (clusterIsSuspicious) {
    state = 'UNSAFE';
    reasons.push('bundled_wallet_cluster_detected');

    const clusterAddresses = new Set(bestCluster.map((h) => h.address));

    if (options?.creatorAddress && clusterAddresses.has(options.creatorAddress)) {
      reasons.push('creator_wallet_in_cluster');
    }

    if (options?.fundingSourceByAddress) {
      const fundingSources = bestCluster
        .map((h) => options.fundingSourceByAddress![h.address])
        .filter((source): source is string => source !== undefined);
      const uniqueSources = new Set(fundingSources);
      if (fundingSources.length >= 2 && uniqueSources.size === 1) {
        reasons.push('coordinated_wallet_funding_detected');
      }
    }
  }

  return { state, reasons, largestClusterWalletCount, largestClusterSupplyPercent };
}
