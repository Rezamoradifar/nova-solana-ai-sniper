import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { Redis } from 'ioredis';
import type { PositionManager } from './positionManager.js';
import { SafetyCheckError } from './safety.js';

export interface CopyTradeSignal {
  targetAddress: string;
  mint: string;
  tokenId: string;
  amountSolOriginal: number;
  entryPriceUsd: number;
  signature: string;
}

/**
 * Mirrors a tracked wallet's buy into every user's CopyTradeConfig pointed at
 * that address, scaling size by `copyPercentSize` and clamping to `maxAmountSol`.
 */
export class CopyTradingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly positionManager: PositionManager,
    private readonly logger: Logger,
    private readonly encryptionKey: string,
    private readonly redis: Redis,
  ) {}

  async mirror(signal: CopyTradeSignal) {
    const configs = await this.prisma.copyTradeConfig.findMany({
      where: { isActive: true, targetAddress: signal.targetAddress },
      include: { user: { include: { wallets: { where: { isActive: true } } } } },
    });

    if (configs.length === 0) return;

    const claimed = await this.redis
      .set(`copy-trading:signal:${signal.signature}`, '1', 'EX', 7 * 24 * 60 * 60, 'NX')
      .catch(() => null);
    if (claimed !== 'OK') {
      this.logger.debug(
        { signature: signal.signature, targetAddress: signal.targetAddress },
        'copy trade signal already processed',
      );
      return;
    }

    for (const config of configs) {
      const wallet = config.user.wallets[0];
      if (!wallet) continue;

      let amountSol = signal.amountSolOriginal * (config.copyPercentSize / 100);
      if (config.maxAmountSol != null) {
        amountSol = Math.min(amountSol, config.maxAmountSol);
      }
      if (amountSol <= 0) continue;

      try {
        await this.positionManager.openPosition({
          userId: config.userId,
          walletId: wallet.id,
          walletPublicKey: wallet.publicKey,
          encryptedSecret: wallet.encryptedSecret,
          encryptionKey: this.encryptionKey,
          tokenId: signal.tokenId,
          mint: signal.mint,
          amountSol,
          slippageBps: 300,
        });
      } catch (err) {
        if (err instanceof SafetyCheckError) {
          this.logger.warn(
            { userId: config.userId, targetAddress: signal.targetAddress, reason: err.reason },
            'copy trade blocked by safety check',
          );
          continue;
        }
        this.logger.error(
          { err, userId: config.userId, targetAddress: signal.targetAddress },
          'copy trade execution failed',
        );
      }
    }
  }
}
