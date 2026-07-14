import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { DexScreenerClient } from '../solana/dexscreener.js';
import type { PositionManager } from './positionManager.js';
import { isPlausiblePriceUpdate } from './exitEngine.js';

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

          // Reject an implausible single-tick outlier before it can corrupt this
          // position's (monotonic, self-reinforcing) high-water mark or fire a
          // bogus exit off a phantom price — see exitEngine.ts's
          // isPlausiblePriceUpdate doc comment for the live-verified incident.
          const referencePriceUsd = position.highWaterMarkUsd ?? position.entryPriceUsd;
          if (!isPlausiblePriceUpdate(referencePriceUsd, currentPriceUsd)) {
            this.deps.logger.warn(
              {
                positionId: position.id,
                mint: position.token.mint,
                referencePriceUsd,
                currentPriceUsd,
              },
              'price tick rejected as implausible outlier — skipping this position this tick',
            );
            continue;
          }

          await this.deps.positionManager.checkAndMaybeClose(
            position.id,
            currentPriceUsd,
            position.wallet.encryptedSecret,
            this.deps.encryptionKey,
          );
        } catch (err) {
          // Production Bug Fix (2026-07-14): this catch previously covered both
          // a DexScreener price-fetch failure above AND a SELL execution
          // failure from checkAndMaybeClose below under the same generic
          // message, with no way to tell which happened or why from the log
          // line alone. PositionManager tags every SELL failure it throws
          // with `.sellFailureCategory` (see sellFailureClassifier.ts) — when
          // present, log it as a distinct, categorized SELL failure instead.
          const category = (err as { sellFailureCategory?: string } | null)?.sellFailureCategory;
          if (category) {
            this.deps.logger.error(
              { err, positionId: position.id, mint: position.token.mint, category },
              `SELL execution failed [${category}]`,
            );
          } else {
            this.deps.logger.error(
              { err, positionId: position.id },
              'price check failed for open position',
            );
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
