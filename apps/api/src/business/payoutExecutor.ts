import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import { unsealKeypair } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';
import { broadcastTransaction } from '../solana/broadcast.js';
import { JitoClient } from '../solana/jito.js';
import {
  buildTransferInstructions,
  decidePayoutAction,
  evaluatePayoutBalanceSufficiency,
  resolvePayoutRecipients,
  type PayoutRecipient,
  type ReferralPayoutOutcome,
  type ReferrerWalletLookup,
} from './payoutCalculation.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
/** A single System-Program transfer instruction costs the base 5000-lamport
 * signature fee; a combined transaction with up to ~3 recipients (2
 * referrers + treasury) stays well within one signature's base fee in
 * practice, so a small fixed estimate (rather than a live simulation) is
 * good enough for the pre-flight balance check — the real fee actually
 * charged can never exceed what the network requires, and any shortfall
 * would surface as a broadcast failure, not a silent partial payout. */
const ESTIMATED_TX_FEE_LAMPORTS = 15_000n;

export interface PayoutExecutorDeps {
  prisma: PrismaClient;
  connection: Connection;
  jito?: JitoClient;
  logger: Logger;
  encryptionKey: string;
  treasuryAddress: string;
  minWalletReserveSol: number;
  staleMs: number;
  notifier?: NotificationService;
  getSolPriceUsd: () => Promise<number | undefined>;
}

export interface PayoutParams {
  positionId: string;
  walletId: string;
  walletPublicKey: string;
  encryptedSecret: string;
  referralRewards: ReferrerWalletLookup[];
  /** The platform's own net share — the fee pool minus every referral
   * reward already computed for this close. */
  platformShareUsd: number;
}

export type PayoutOutcome =
  | {
      kind: 'confirmed';
      txSignature: string;
      recipients: PayoutRecipient[];
      referralOutcomes: ReferralPayoutOutcome[];
    }
  | { kind: 'skipped'; reason: 'insufficient_balance' | 'no_payout_needed' }
  | { kind: 'failed'; reason: string }
  | { kind: 'deferred' };

/**
 * Real on-chain payout of referral commissions + the platform's own share
 * (2026-07-23) — the only place that touches `connection`, writes
 * `PayoutAttempt`, or holds the trader's decrypted keypair. See
 * schema.prisma's PayoutAttempt doc comment for the full idempotency/
 * ordering rationale this function implements step by step.
 */
export async function executeReferralAndPlatformPayout(
  deps: PayoutExecutorDeps,
  params: PayoutParams,
): Promise<PayoutOutcome> {
  const referralRewards = params.referralRewards;
  const hasAnyPayout = params.platformShareUsd > 0 || referralRewards.some((r) => r.rewardUsd > 0);
  if (!hasAnyPayout) return { kind: 'skipped', reason: 'no_payout_needed' };

  const solPriceUsd = await deps.getSolPriceUsd();
  if (solPriceUsd === undefined) {
    deps.logger.error(
      { positionId: params.positionId },
      'payout executor: could not resolve a SOL/USD price — cannot compute the on-chain transfer, leaving unattempted for a later retry',
    );
    return { kind: 'failed', reason: 'sol_price_unavailable' };
  }

  const { recipients, referralOutcomes, totalLamports } = resolvePayoutRecipients({
    referralRewards,
    platformShareUsd: params.platformShareUsd,
    treasuryAddress: deps.treasuryAddress,
    solPriceUsd,
  });
  if (recipients.length === 0) return { kind: 'skipped', reason: 'no_payout_needed' };

  let justCreated = true;
  const attempt = await deps.prisma.payoutAttempt
    .create({
      data: {
        positionId: params.positionId,
        walletId: params.walletId,
        status: 'PENDING',
        solPriceUsdAtCalc: solPriceUsd,
        treasuryAddress: deps.treasuryAddress,
        treasuryLamports:
          recipients.find((r) => r.toAddress === deps.treasuryAddress)?.lamports ?? 0n,
        referralBreakdown: referralOutcomes as never,
        totalLamports,
        estimatedFeeLamports: ESTIMATED_TX_FEE_LAMPORTS,
      },
    })
    .catch(async (err: unknown) => {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      // The unique constraint on positionId means a row already exists — a
      // genuine concurrent duplicate fire, not a real error (same convention
      // PerformanceFeeLedger's own P2002 handling already uses). Fetch it
      // and let decidePayoutAction (below) decide what to do with it,
      // rather than proceeding as if this were a fresh attempt.
      justCreated = false;
      const found = await deps.prisma.payoutAttempt.findUnique({
        where: { positionId: params.positionId },
      });
      if (!found) throw err; // genuinely unexpected — surface the original error
      return found;
    });

  if (!justCreated) {
    const decision = decidePayoutAction(attempt, Date.now(), deps.staleMs);
    if (
      decision.action === 'skip_already_done' ||
      decision.action === 'skip_concurrent_in_progress'
    ) {
      return { kind: 'deferred' };
    }
    if (decision.action === 'alert_stuck') {
      deps.logger.error(
        {
          positionId: params.positionId,
          status: attempt.status,
          since: attempt.processingStartedAt,
        },
        'payout attempt stuck — requires manual on-chain reconciliation',
      );
      await deps.notifier?.notifyError(
        'stuck payout attempt',
        `Payout for position ${params.positionId} has been stuck in ${attempt.status} since ${attempt.processingStartedAt.toISOString()} — please reconcile manually (check txSignature ${attempt.txSignature ?? 'none recorded'} on-chain before taking any action).`,
      );
      return { kind: 'deferred' };
    }
    // decidePayoutAction never returns 'start' for a non-null existing row — unreachable.
    return { kind: 'deferred' };
  }

  const balanceLamports = BigInt(
    await deps.connection.getBalance(new PublicKey(params.walletPublicKey)),
  );
  const reserveLamports = BigInt(Math.round(deps.minWalletReserveSol * LAMPORTS_PER_SOL));
  const balanceCheck = evaluatePayoutBalanceSufficiency(
    balanceLamports,
    totalLamports,
    ESTIMATED_TX_FEE_LAMPORTS,
    reserveLamports,
  );
  if (!balanceCheck.allowed) {
    await deps.prisma.payoutAttempt.update({
      where: { positionId: params.positionId },
      data: { status: 'SKIPPED_INSUFFICIENT_BALANCE', failureReason: balanceCheck.reason },
    });
    deps.logger.warn(
      { positionId: params.positionId, reason: balanceCheck.reason },
      'payout skipped — insufficient wallet balance',
    );
    await deps.notifier?.notifyError(
      'payout skipped — insufficient balance',
      `Position ${params.positionId}: referral/platform payout skipped, the trader's wallet balance can't cover it. ${balanceCheck.reason}. This will not be retried automatically.`,
    );
    return { kind: 'skipped', reason: 'insufficient_balance' };
  }

  let keypair: Keypair;
  try {
    keypair = unsealKeypair(params.encryptedSecret, deps.encryptionKey);
  } catch (err) {
    await deps.prisma.payoutAttempt.update({
      where: { positionId: params.positionId },
      data: { status: 'FAILED', failureReason: 'wallet decryption failed' },
    });
    deps.logger.error(
      { err, positionId: params.positionId },
      'payout failed — could not decrypt wallet',
    );
    await deps.notifier?.notifyError(
      'payout failed',
      `Position ${params.positionId}: payout failed — wallet decryption error.`,
    );
    return { kind: 'failed', reason: 'wallet_decryption_failed' };
  }

  const instructions = buildTransferInstructions(keypair.publicKey, recipients);
  const { blockhash, lastValidBlockHeight } = await deps.connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([keypair]);
  const txSignature = bs58.encode(transaction.signatures[0]!);

  // Durably record the signature BEFORE broadcasting — see schema.prisma's
  // PayoutAttempt doc comment for why this ordering is the actual safety
  // guarantee: a crash after this write can always be reconciled by looking
  // up this exact signature on-chain, never by guessing or blindly resending.
  await deps.prisma.payoutAttempt.update({
    where: { positionId: params.positionId },
    data: { status: 'SUBMITTED', txSignature },
  });

  try {
    await broadcastTransaction(
      { connection: deps.connection, logger: deps.logger, jito: deps.jito },
      transaction,
      keypair,
      lastValidBlockHeight,
    );
  } catch (err) {
    await deps.prisma.payoutAttempt.update({
      where: { positionId: params.positionId },
      data: { status: 'FAILED', failureReason: err instanceof Error ? err.message : String(err) },
    });
    deps.logger.error(
      { err, positionId: params.positionId, txSignature },
      'payout broadcast failed',
    );
    await deps.notifier?.notifyError(
      'payout failed',
      `Position ${params.positionId}: referral/platform payout transaction failed (signature ${txSignature}) — please check on-chain before any manual retry.`,
    );
    return { kind: 'failed', reason: 'broadcast_failed' };
  }

  await deps.prisma.payoutAttempt.update({
    where: { positionId: params.positionId },
    data: { status: 'CONFIRMED', confirmedAt: new Date() },
  });

  return { kind: 'confirmed', txSignature, recipients, referralOutcomes };
}
