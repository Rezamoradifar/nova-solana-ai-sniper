import type { PrismaClient } from '@prisma/client';
import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from '../logger.js';
import { writeLedgerAndAudit } from './ledgerWrite.js';

export interface RefreshBalanceDeps {
  prisma: PrismaClient;
  connection: Connection;
  logger?: Logger;
}

export interface RefreshBalanceResult {
  walletId: string;
  currentLamports: bigint;
  previousLamports: bigint | null;
  deltaLamports: bigint;
  // Set only when this call actually wrote a new DEPOSIT ledger row.
  depositLedgerEntryId?: string;
}

/**
 * The single implementation of "read a wallet's live SOL balance, diff it
 * against the cached value, and record a deposit if it went up" — shared by
 * apps/api's DepositMonitor poll loop, its on-demand
 * POST /wallets/:id/refresh-balance route, and the Telegram bot's Refresh
 * Balance button, so all three can never disagree about what counts as a
 * deposit or double-write one.
 *
 * Returns undefined if the wallet doesn't exist or is inactive.
 */
export async function refreshWalletBalance(
  deps: RefreshBalanceDeps,
  walletId: string,
  opts?: { ip?: string; source?: 'deposit_monitor' | 'refresh_endpoint' | 'telegram' },
): Promise<RefreshBalanceResult | undefined> {
  const wallet = await deps.prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet || !wallet.isActive) return undefined;

  const lamports = BigInt(await deps.connection.getBalance(new PublicKey(wallet.publicKey)));
  const previous = wallet.lastKnownBalanceLamports;

  // First-ever read for this wallet (true for every existing wallet before
  // this feature shipped, since lastKnownBalanceLamports starts null): seed
  // the cache only, never log a "deposit" — otherwise every wallet gets one
  // fabricated DEPOSIT ledger row the moment this code first runs against it.
  if (previous === null) {
    await deps.prisma.wallet.update({
      where: { id: walletId },
      data: { lastKnownBalanceLamports: lamports, balanceUpdatedAt: new Date() },
    });
    return { walletId, currentLamports: lamports, previousLamports: null, deltaLamports: 0n };
  }

  const delta = lamports - previous;

  if (delta <= 0n) {
    // Unchanged, or a decrease — spent on trading/gas (already tracked via
    // Trade/Position) or an off-band withdrawal recorded separately. Either
    // way, not an auto-logged ledger event; just refresh the cache.
    await deps.prisma.wallet.update({
      where: { id: walletId },
      data: { lastKnownBalanceLamports: lamports, balanceUpdatedAt: new Date() },
    });
    return {
      walletId,
      currentLamports: lamports,
      previousLamports: previous,
      deltaLamports: delta,
    };
  }

  // A real increase: write the DEPOSIT ledger/audit pair and update the
  // cache in one transaction, guarded by an optimistic check against the
  // balance we just read so two concurrent callers (e.g. the poller and an
  // on-demand refresh) racing on the same wallet can't double-count one
  // real deposit.
  let depositLedgerEntryId: string | undefined;
  await deps.prisma.$transaction(async (tx) => {
    const updated = await tx.wallet.updateMany({
      where: { id: walletId, lastKnownBalanceLamports: previous },
      data: { lastKnownBalanceLamports: lamports, balanceUpdatedAt: new Date() },
    });
    if (updated.count === 0) {
      // Another caller already won this race and recorded this deposit.
      return;
    }
    const written = await writeLedgerAndAudit(tx, {
      type: 'DEPOSIT',
      asset: 'SOL',
      direction: 'CREDIT',
      amountLamports: delta,
      balanceAfterLamports: lamports,
      userId: wallet.userId,
      walletId: wallet.id,
      action: 'wallet.deposit_detected',
      metadata: { source: opts?.source ?? 'refresh_endpoint' },
      ip: opts?.ip,
    });
    depositLedgerEntryId = written.ledgerEntryId;
  });

  if (depositLedgerEntryId) {
    deps.logger?.info(
      { walletId, deltaLamports: delta.toString(), source: opts?.source },
      'wallet balance increase recorded as deposit',
    );
  }

  return {
    walletId,
    currentLamports: lamports,
    previousLamports: previous,
    deltaLamports: delta,
    depositLedgerEntryId,
  };
}
