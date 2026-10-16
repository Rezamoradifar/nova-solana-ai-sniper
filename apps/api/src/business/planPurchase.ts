import bs58 from 'bs58';
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import {
  computePlanExpiry,
  getOrCreateBusinessSettings,
  isValidSolanaPublicKey,
  unsealKeypair,
  type Logger,
} from '@nova/shared';
import { broadcastTransaction } from '../solana/broadcast.js';
import { invalidatePlanCache } from '../lib/plans.js';

const TX_FEE_LAMPORTS = 10_000n;

export interface PlanPurchaseDeps {
  prisma: PrismaClient;
  connection: Connection;
  logger: Logger;
  encryptionKey: string;
  envTreasuryAddress?: string;
  minWalletReserveSol: number;
}

export type PlanPurchaseResult =
  | { ok: true; planKey: string; expiresAt: Date; txSignature: string; amountSol: number }
  | { ok: false; error: string; paymentUncertain?: boolean };

const inFlight = new Set<string>();

/**
 * Buys a package: moves the plan price in SOL from the user's own bot wallet
 * to the treasury, then records the subscription and moves the user onto the
 * plan. The signature is logged before broadcasting so a crash in between can
 * always be reconciled on-chain.
 */
export async function purchasePlan(
  deps: PlanPurchaseDeps,
  params: { userId: string; planKey: string; walletId?: string; expectedPriceSol?: number },
): Promise<PlanPurchaseResult> {
  if (inFlight.has(params.userId)) return { ok: false, error: 'A purchase is already in progress' };
  inFlight.add(params.userId);
  try {
    return await purchaseLocked(deps, params);
  } finally {
    inFlight.delete(params.userId);
  }
}

async function purchaseLocked(
  deps: PlanPurchaseDeps,
  params: { userId: string; planKey: string; walletId?: string; expectedPriceSol?: number },
): Promise<PlanPurchaseResult> {
  const { prisma } = deps;
  const plan = await prisma.subscriptionPlan.findUnique({ where: { key: params.planKey } });
  if (!plan || !plan.active) return { ok: false, error: 'This package is not available' };
  if (plan.priceSol <= 0) return { ok: false, error: 'This package is free; nothing to buy' };
  if (params.expectedPriceSol !== undefined && plan.priceSol !== params.expectedPriceSol) {
    return {
      ok: false,
      error: 'The plan price changed. Refresh and review the new price before paying.',
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { id: true, planKey: true, planExpiresAt: true },
  });
  if (!user) return { ok: false, error: 'User not found' };

  const wallet = await prisma.wallet.findFirst({
    where: { userId: user.id, isActive: true, ...(params.walletId ? { id: params.walletId } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  if (!wallet) return { ok: false, error: 'No active wallet to pay from' };

  const settings = await getOrCreateBusinessSettings(prisma);
  const treasury = settings.treasuryWalletAddress ?? deps.envTreasuryAddress;
  if (!treasury || !isValidSolanaPublicKey(treasury)) {
    return { ok: false, error: 'Payments are not set up yet (no treasury wallet)' };
  }
  if (treasury === wallet.publicKey)
    return { ok: false, error: 'Cannot pay from the treasury wallet itself' };

  const priceLamports = BigInt(Math.round(plan.priceSol * LAMPORTS_PER_SOL));
  const reserveLamports = BigInt(Math.round(deps.minWalletReserveSol * LAMPORTS_PER_SOL));
  const balance = BigInt(await deps.connection.getBalance(new PublicKey(wallet.publicKey)));
  const needed = priceLamports + TX_FEE_LAMPORTS + reserveLamports;
  if (balance < needed) {
    const fmt = (l: bigint) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4);
    return {
      ok: false,
      error: `Insufficient balance: need ${fmt(needed)} SOL, wallet has ${fmt(balance)} SOL`,
    };
  }

  const keypair = unsealKeypair(wallet.encryptedSecret, deps.encryptionKey);
  const { blockhash, lastValidBlockHeight } = await deps.connection.getLatestBlockhash();
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(treasury),
          lamports: priceLamports,
        }),
      ],
    }).compileToV0Message(),
  );
  tx.sign([keypair]);
  const txSignature = bs58.encode(tx.signatures[0]!);
  deps.logger.info(
    { userId: user.id, planKey: plan.key, amountSol: plan.priceSol, txSignature },
    'PLAN PURCHASE: broadcasting payment',
  );

  try {
    await broadcastTransaction(
      { connection: deps.connection, logger: deps.logger },
      tx,
      keypair,
      lastValidBlockHeight,
    );
  } catch (err) {
    deps.logger.error({ err, userId: user.id, txSignature }, 'PLAN PURCHASE: payment failed');
    return {
      ok: false,
      paymentUncertain: true,
      error: `Payment did not confirm. Check ${txSignature} on Solscan before trying again.`,
    };
  }

  const { startsAt, expiresAt } = computePlanExpiry(user, plan.key, plan.durationDays);
  await prisma.$transaction([
    prisma.subscription.create({
      data: {
        userId: user.id,
        planKey: plan.key,
        amountSol: plan.priceSol,
        txSignature,
        startsAt,
        expiresAt,
      },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { planKey: plan.key, planExpiresAt: expiresAt, subscriptionTier: 'PRO' },
    }),
  ]);
  invalidatePlanCache();
  deps.logger.info(
    { userId: user.id, planKey: plan.key, expiresAt, txSignature },
    'PLAN PURCHASE: confirmed',
  );
  return { ok: true, planKey: plan.key, expiresAt, txSignature, amountSol: plan.priceSol };
}
