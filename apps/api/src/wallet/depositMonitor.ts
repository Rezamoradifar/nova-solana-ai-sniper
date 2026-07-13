import type { PrismaClient } from '@prisma/client';
import type { Connection } from '@solana/web3.js';
import type { Logger } from '@nova/shared';
import { refreshWalletBalance } from '@nova/shared';

export interface DepositMonitorDeps {
  prisma: PrismaClient;
  connection: Connection;
  logger: Logger;
}

/**
 * Polls every active wallet's live SOL balance on an interval and records
 * any increase as a DEPOSIT ledger/audit event via the shared
 * refreshWalletBalance helper (packages/shared/src/wallet/balanceLedger.ts)
 * — the same helper the on-demand /wallets/:id/refresh-balance route and the
 * Telegram bot's refresh button call, so all three sources of a balance
 * check agree on what counts as a deposit. Same start/stop/tick shape as
 * PriceMonitor (apps/api/src/trading/priceMonitor.ts).
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
      for (const wallet of wallets) {
        try {
          await refreshWalletBalance(
            {
              prisma: this.deps.prisma,
              connection: this.deps.connection,
              logger: this.deps.logger,
            },
            wallet.id,
            { source: 'deposit_monitor' },
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
