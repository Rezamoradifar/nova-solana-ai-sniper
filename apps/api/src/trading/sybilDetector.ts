import type { Connection, PublicKey as PublicKeyType } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { Logger } from '@nova/shared';
import { createHash } from 'node:crypto';

/**
 * Sybil / manipulated-cluster detection for Smart Money Analysis (Sections
 * 3-4, 2026-07-22). Pure grouping/scoring functions here; the one I/O lookup
 * (resolveFundingSource) is deliberately bounded to a single hop — see its
 * own doc comment — to keep RPC cost predictable per wallet.
 */

export interface WalletFundingInfo {
  walletAddress: string;
  /** Resolved earliest-inbound-SOL-transfer source, if found. */
  fundingSource?: string;
}

/** Deterministic, stable across processes/restarts (unlike a random UUID) so
 * the same funding source always maps to the same cluster id. */
export function clusterIdForFundingSource(fundingSource: string): string {
  return createHash('sha256').update(fundingSource).digest('hex').slice(0, 16);
}

/** Groups wallets sharing a resolved funding source. Wallets with no
 * resolved funding source are never grouped (each is its own singleton, not
 * lumped together) — an unresolved lookup is "unknown," not "same." */
export function groupBySharedFundingSource(wallets: WalletFundingInfo[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const w of wallets) {
    if (!w.fundingSource) continue;
    const clusterId = clusterIdForFundingSource(w.fundingSource);
    const existing = groups.get(clusterId);
    if (existing) existing.push(w.walletAddress);
    else groups.set(clusterId, [w.walletAddress]);
  }
  return groups;
}

export interface WalletTimingInfo extends WalletFundingInfo {
  buyTimestampMs: number;
  buyAmountSol?: number;
}

/** Buys within this tight a spread, at matching size, are suspicious even
 * without a confirmed shared funding source — real independent buyers rarely
 * transact within seconds of each other at near-identical size. */
const TIGHT_TIMING_SPREAD_MS = 10_000;
const TIGHT_AMOUNT_COEFFICIENT_OF_VARIATION = 0.05;

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * 0-100 suspicion score for a group of wallets already known to share a
 * funding source (or being evaluated for tight-timing suspicion alone).
 * Bigger groups, tighter buy timing, and near-identical buy sizes each push
 * the score up — used to set SmartWallet.sybilConfidencePct, which
 * multiplicatively discounts (never hard-excludes) a wallet's contribution
 * to SmartMoneyScore.
 */
export function scoreClusterSuspicion(cluster: WalletTimingInfo[]): number {
  if (cluster.length < 2) return 0;

  // Shared-funding-source clusters (the primary signal) already implies
  // every member here shares one — group size alone is meaningful: 2 wallets
  // sharing a funder is common (e.g. a couple funding two personal wallets),
  // 5+ funded from one source buying the same token is not.
  let score = Math.min(60, (cluster.length - 1) * 20);

  const timestamps = cluster.map((c) => c.buyTimestampMs);
  const spread = Math.max(...timestamps) - Math.min(...timestamps);
  if (spread <= TIGHT_TIMING_SPREAD_MS) {
    score += 25;
  }

  const amounts = cluster.map((c) => c.buyAmountSol).filter((a): a is number => a !== undefined);
  if (
    amounts.length >= 2 &&
    coefficientOfVariation(amounts) <= TIGHT_AMOUNT_COEFFICIENT_OF_VARIATION
  ) {
    score += 15;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * One-hop funding-source resolution, bounded to a single page of signature
 * history (limit 1000) plus one parsed-transaction fetch — deliberately NOT
 * a full pagination walk to a wallet's true genesis transaction, which would
 * be unbounded RPC cost for an old/active wallet. If the returned page is
 * shorter than the limit, it genuinely is the wallet's full history (typical
 * for a freshly-created single-purpose wallet — exactly the profile this
 * exists to catch); if the page is full, the wallet already has 1000+
 * transactions and is in practice not a fresh Sybil wallet anyway, so this
 * returns undefined rather than paginating further. Fails open (undefined)
 * on any RPC error — never blocks or throws into the pipeline.
 */
export async function resolveFundingSource(
  connection: Connection,
  walletAddress: string,
  logger: Logger,
): Promise<string | undefined> {
  try {
    const pubkey: PublicKeyType = new PublicKey(walletAddress);
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 1000 });
    if (signatures.length === 0 || signatures.length >= 1000) return undefined;

    const oldest = signatures[signatures.length - 1]!;
    const tx = await connection.getParsedTransaction(oldest.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return undefined;

    for (const ix of tx.transaction.message.instructions) {
      if (
        'parsed' in ix &&
        ix.program === 'system' &&
        ix.parsed?.type === 'transfer' &&
        ix.parsed.info?.destination === walletAddress &&
        typeof ix.parsed.info?.source === 'string'
      ) {
        return ix.parsed.info.source as string;
      }
    }
    return undefined;
  } catch (err) {
    logger.debug({ walletAddress, err }, 'sybilDetector: funding source resolution failed');
    return undefined;
  }
}
