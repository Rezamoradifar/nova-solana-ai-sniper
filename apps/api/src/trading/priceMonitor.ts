import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { DexScreenerClient } from '../solana/dexscreener.js';
import type { PositionManager } from './positionManager.js';

export interface PriceMonitorDeps {
  prisma: PrismaClient;
  dexScreener: DexScreenerClient;
  positionManager: PositionManager;
  logger: Logger;
  encryptionKey: string;
}

/**
 * Polls every OPEN position's current price and hands it to
 * PositionManager.checkAndMaybeClose, which decides (via the pure evaluateExit
 * logic) whether take-profit/stop-loss/trailing-stop should fire. This is the
 * piece that makes those fields actually do something — without a loop
 * driving it, they're just stored numbers nothing ever reads.
 */
export class PriceMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly deps: PriceMonitorDeps) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    // A slow RPC/API round-trip on one tick should never overlap with the next timer fire.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const openPositions = await this.deps.prisma.position.findMany({
        where: { status: 'OPEN' },
        include: { token: true, wallet: true },
      });

      for (const position of openPositions) {
        try {
          const pair = await this.deps.dexScreener.getBestSolanaPair(position.token.mint);
          const currentPriceUsd = pair?.priceUsd ? Number(pair.priceUsd) : undefined;
          if (currentPriceUsd === undefined || !Number.isFinite(currentPriceUsd)) continue;

          await this.deps.positionManager.checkAndMaybeClose(
            position.id,
            currentPriceUsd,
            position.wallet.encryptedSecret,
            this.deps.encryptionKey,
          );
        } catch (err) {
          this.deps.logger.error(
            { err, positionId: position.id },
            'price check failed for open position',
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
