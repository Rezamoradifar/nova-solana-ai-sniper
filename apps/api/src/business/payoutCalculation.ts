import type { PayoutStatus } from '@prisma/client';
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Real on-chain payout of referral commissions + the platform's own share
 * (2026-07-23), replacing the previous ledger-only bookkeeping (see
 * registerFeeSystem.ts and payoutExecutor.ts). Every function here is pure —
 * no DB/RPC access — same convention as safety.ts's evaluateWalletBalance
 * and entryFilter.ts's evaluateEntry, so the actual money-math and the
 * idempotency state machine are exhaustively unit-testable without a live
 * connection or database.
 */

export interface ReferrerWalletLookup {
  referrerUserId: string;
  level: number;
  rewardUsd: number;
  /** The referrer's resolved payout wallet address — undefined means they
   * have zero active wallets (a real, if rare, edge case): their share
   * rolls into the treasury payment instead of being silently dropped, the
   * same "unclaimed shares roll into the platform's share" philosophy
   * packages/shared/src/fee.ts's calculateFixedProfitDistribution already
   * uses. */
  payoutPublicKey?: string;
}

export interface PayoutRecipient {
  toAddress: string;
  lamports: bigint;
}

export interface ReferralPayoutOutcome {
  referrerUserId: string;
  level: number;
  toAddress: string;
  rolledUpToTreasury: boolean;
}

export interface ResolvedPayout {
  /** Deduped by destination address — two amounts bound for the same
   * address (e.g. a rolled-up referral share and the platform's own share,
   * or a referrer wallet that happens to equal the treasury address) merge
   * into exactly one transfer instruction. */
  recipients: PayoutRecipient[];
  /** One entry per input referral reward, for the caller to persist onto
   * each ReferralReward row (payoutWalletId/rolledUpToTreasury). */
  referralOutcomes: ReferralPayoutOutcome[];
  totalLamports: bigint;
}

function usdToLamports(usd: number, solPriceUsd: number): bigint {
  if (usd <= 0 || solPriceUsd <= 0) return 0n;
  return BigInt(Math.round((usd / solPriceUsd) * LAMPORTS_PER_SOL));
}

/**
 * Converts USD amounts to lamports at a single frozen SOL price. Never
 * drops a share on the floor: a referrer with no resolvable wallet has
 * their share rolled into the treasury address instead.
 */
export function resolvePayoutRecipients(input: {
  referralRewards: ReferrerWalletLookup[];
  /** The platform's own net share (the fee pool minus every referral
   * reward already computed for this close) — already-computed upstream,
   * this function only converts and routes it. */
  platformShareUsd: number;
  treasuryAddress: string;
  solPriceUsd: number;
}): ResolvedPayout {
  const byAddress = new Map<string, bigint>();
  const referralOutcomes: ReferralPayoutOutcome[] = [];

  const addLamports = (address: string, lamports: bigint) => {
    if (lamports <= 0n) return;
    byAddress.set(address, (byAddress.get(address) ?? 0n) + lamports);
  };

  for (const reward of input.referralRewards) {
    const lamports = usdToLamports(reward.rewardUsd, input.solPriceUsd);
    const rolledUp = reward.payoutPublicKey === undefined;
    const toAddress = reward.payoutPublicKey ?? input.treasuryAddress;
    addLamports(toAddress, lamports);
    referralOutcomes.push({
      referrerUserId: reward.referrerUserId,
      level: reward.level,
      toAddress,
      rolledUpToTreasury: rolledUp,
    });
  }

  addLamports(input.treasuryAddress, usdToLamports(input.platformShareUsd, input.solPriceUsd));

  const recipients: PayoutRecipient[] = Array.from(byAddress.entries()).map(
    ([toAddress, lamports]) => ({
      toAddress,
      lamports,
    }),
  );
  const totalLamports = recipients.reduce((sum, r) => sum + r.lamports, 0n);

  return { recipients, referralOutcomes, totalLamports };
}

export interface PayoutBalanceCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Same shape/convention as safety.ts's SafetyCheckResult — checked against a
 * FRESH on-chain balance (never the stale Wallet.lastKnownBalanceLamports
 * cache), before signing anything. Never allows a partial payout: this is a
 * hard gate, not a scaling factor.
 */
export function evaluatePayoutBalanceSufficiency(
  balanceLamports: bigint,
  totalPayoutLamports: bigint,
  estimatedFeeLamports: bigint,
  reserveLamports: bigint,
): PayoutBalanceCheckResult {
  const required = totalPayoutLamports + estimatedFeeLamports + reserveLamports;
  if (balanceLamports < required) {
    return {
      allowed: false,
      reason: `Wallet balance ${balanceLamports} lamports is below the ${required} lamports required (payout + estimated fee + reserve)`,
    };
  }
  return { allowed: true };
}

/** One SystemProgram.transfer instruction per unique recipient — no I/O,
 * fully deterministic given the resolved recipients. */
export function buildTransferInstructions(
  fromPubkey: PublicKey,
  recipients: PayoutRecipient[],
): TransactionInstruction[] {
  return recipients.map((r) =>
    SystemProgram.transfer({
      fromPubkey,
      toPubkey: new PublicKey(r.toAddress),
      lamports: r.lamports,
    }),
  );
}

export type PayoutDecision =
  | { action: 'start' }
  | { action: 'skip_already_done' }
  | { action: 'skip_concurrent_in_progress' }
  | { action: 'alert_stuck' };

const NON_TERMINAL_STATUSES: readonly PayoutStatus[] = ['PENDING', 'SUBMITTED'];

/**
 * The idempotency state machine (see PayoutAttempt's own schema.prisma doc
 * comment for the full ordering rationale). Pure, given the persisted row
 * (or null, meaning no attempt exists yet) and "now" — fully unit-testable
 * without touching a database.
 */
export function decidePayoutAction(
  existing: { status: PayoutStatus; processingStartedAt: Date } | null,
  nowMs: number,
  staleMs: number,
): PayoutDecision {
  if (!existing) return { action: 'start' };
  if (!NON_TERMINAL_STATUSES.includes(existing.status)) return { action: 'skip_already_done' };

  const ageMs = nowMs - existing.processingStartedAt.getTime();
  return ageMs >= staleMs ? { action: 'alert_stuck' } : { action: 'skip_concurrent_in_progress' };
}
