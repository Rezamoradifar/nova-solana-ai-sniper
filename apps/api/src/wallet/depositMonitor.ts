import type { PrismaClient } from '@prisma/client';
import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { Logger } from '@nova/shared';
import { refreshWalletBalance } from '@nova/shared';

export interface DepositMonitorDeps {
  prisma: PrismaClient;
  connection: Connection;
  logger: Logger;
}

// Solana's getMultipleAccountsInfo protocol limit; some providers' plans cap
// it lower and reject larger batches with 413 (already handled as a
// retryable/failover case in resilientConnection.ts), but this chunk size is
// never itself the cause of a 413 against a provider that supports the full
// protocol limit.
const BALANCE_BATCH_SIZE = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Polls every active wallet's live SOL balance on an interval and records
 * any increase as a DEPOSIT ledger/audit event via the shared
 * refreshWalletBalance helper (packages/shared/src/wallet/balanceLedger.ts)
 * — the same helper the on-demand /wallets/:id/refresh-balance route and the
 * Telegram bot's refresh button call, so all three sources of a balance
 * check agree on what counts as a deposit. Same start/stop/tick shape as
 * PriceMonitor (apps/api/src/trading/priceMonitor.ts).
 *
 * 2026-07-15 Helius credit audit: previously issued one getBalance RPC call
 * per active wallet per tick (linear in wallet count, unbatched — a real
 * contributor to Helius credit burn as the user base grows). Now reads every
 * active wallet's balance with one batched getMultipleAccountsInfo call
 * (chunked at BALANCE_BATCH_SIZE) and passes the prefetched lamport value
 * into refreshWalletBalance, which still owns 100% of the diff/ledger-write
 * logic — this only removes the redundant per-wallet RPC round trip.
 */
export class DepositMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly deps: DepositMonitorDeps) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    // A slow RPC round-trip on one tick should never overlap the next timer fire.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const wallets = await this.deps.prisma.wallet.findMany({ where: { isActive: true } });
      if (wallets.length === 0) return;

      const lamportsByWalletId = new Map<string, bigint>();
      for (const batch of chunk(wallets, BALANCE_BATCH_SIZE)) {
        try {
          const accounts = await this.deps.connection.getMultipleAccountsInfo(
            batch.map((w) => new PublicKey(w.publicKey)),
          );
          batch.forEach((wallet, i) => {
            lamportsByWalletId.set(wallet.id, BigInt(accounts[i]?.lamports ?? 0));
          });
        } catch (err) {
          this.deps.logger.error(
            { err, walletIds: batch.map((w) => w.id) },
            'batched deposit balance read failed for a chunk of wallets',
          );
        }
      }

      for (const wallet of wallets) {
        const prefetchedLamports = lamportsByWalletId.get(wallet.id);
        if (prefetchedLamports === undefined) continue; // this wallet's batch failed above — skip, retried next tick
        try {
          await refreshWalletBalance(
            {
              prisma: this.deps.prisma,
              connection: this.deps.connection,
              logger: this.deps.logger,
            },
            wallet.id,
            { source: 'deposit_monitor', prefetchedLamports },
          );
        } catch (err) {
          this.deps.logger.error(
            { err, walletId: wallet.id },
            'deposit balance poll failed for wallet',
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
