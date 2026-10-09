import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { capBuyAmountForPlan, planBlocksAutoBuy, type Logger } from '@nova/shared';
import { getUserPlanLimits } from '../lib/plans.js';
import type { PositionManager } from './positionManager.js';
import { SafetyCheckError } from './safety.js';

export interface CopyTradeSignal {
  targetAddress: string;
  mint: string;
  tokenId: string;
  amountSolOriginal: number;
  observedAt: number;
}

export interface CopyTradingOptions {
  redis: Redis;
  validateToken: (signal: CopyTradeSignal) => Promise<boolean>;
  maxAmountSol: number;
  maxDailyBuys: number;
  maxOpenPositions: number;
  slippageBps: number;
  maxSignalAgeMs: number;
}

// Reserve BEFORE submission. Failed/uncertain submissions consume a slot too:
// retrying an uncertain on-chain trade must never spend the same budget twice.
export const RESERVE_COPY_BUY = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], 172800)
return 1
`;
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export function copyBudgetDay(now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Copy buys only; PositionManager owns independent stop/trailing exits. */
export class CopyTradingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly positionManager: PositionManager,
    private readonly logger: Logger,
    private readonly encryptionKey: string,
    private readonly options: CopyTradingOptions,
  ) {}

  async mirror(signal: CopyTradeSignal) {
    const fresh = () =>
      Number.isFinite(signal.observedAt) &&
      signal.observedAt <= Date.now() + 5000 &&
      Date.now() - signal.observedAt <= this.options.maxSignalAgeMs;
    if (!fresh() || !Number.isFinite(signal.amountSolOriginal) || signal.amountSolOriginal <= 0)
      return;
    if (!(await this.options.validateToken(signal))) return;
    const configs = await this.prisma.copyTradeConfig.findMany({
      where: {
        isActive: true,
        targetAddress: signal.targetAddress,
        user: { isSuspended: false, deletedAt: null },
      },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          include: { wallets: { where: { isActive: true }, orderBy: { createdAt: 'asc' } } },
        },
      },
    });
    const handledUsers = new Set<string>();
    for (const config of configs) {
      if (handledUsers.has(config.userId)) continue;
      handledUsers.add(config.userId);
      const wallet = config.user.wallets[0];
      if (
        !wallet ||
        wallet.publicKey === signal.targetAddress ||
        config.user.isSuspended ||
        config.user.deletedAt
      )
        continue;
      if (
        !Number.isFinite(config.copyPercentSize) ||
        config.copyPercentSize <= 0 ||
        config.copyPercentSize > 100
      )
        continue;
      if (
        config.maxAmountSol != null &&
        (!Number.isFinite(config.maxAmountSol) || config.maxAmountSol <= 0)
      )
        continue;
      const lockKey = `copy-trade:user-lock:${config.userId}`;
      const lockId = randomUUID();
      // Longer than maximum source age: a stalled call cannot accept another old signal.
      const claimed = await this.options.redis.set(lockKey, lockId, 'EX', 900, 'NX');
      if (claimed !== 'OK') continue;
      try {
        const current = await this.prisma.copyTradeConfig.findFirst({
          where: { id: config.id, isActive: true, user: { isSuspended: false, deletedAt: null } },
        });
        if (!current) continue;
        const plan = await getUserPlanLimits(this.prisma, config.userId);
        const openCount = await this.prisma.position.count({
          where: { wallet: { userId: config.userId }, status: 'OPEN' },
        });
        if (openCount >= this.options.maxOpenPositions || planBlocksAutoBuy(plan, openCount))
          continue;
        const amountSol = capBuyAmountForPlan(
          Math.min(
            (signal.amountSolOriginal * config.copyPercentSize) / 100,
            config.maxAmountSol ?? this.options.maxAmountSol,
            this.options.maxAmountSol,
          ),
          plan,
        );
        if (!Number.isFinite(amountSol) || amountSol <= 0 || !fresh()) continue;
        const reserved = await this.options.redis.eval(
          RESERVE_COPY_BUY,
          1,
          `copy-trade:daily:${config.userId}:${copyBudgetDay()}`,
          this.options.maxDailyBuys,
        );
        if (Number(reserved) !== 1) continue;
        await this.positionManager.openPosition({
          userId: config.userId,
          walletId: wallet.id,
          walletPublicKey: wallet.publicKey,
          encryptedSecret: wallet.encryptedSecret,
          encryptionKey: this.encryptionKey,
          tokenId: signal.tokenId,
          mint: signal.mint,
          amountSol,
          slippageBps: this.options.slippageBps,
        });
      } catch (err) {
        if (err instanceof SafetyCheckError) {
          this.logger.warn(
            { userId: config.userId, targetAddress: signal.targetAddress, reason: err.reason },
            'copy trade blocked by safety check',
          );
        } else {
          this.logger.error(
            { err, userId: config.userId, targetAddress: signal.targetAddress },
            'copy trade execution failed',
          );
        }
      } finally {
        // Ownership check prevents an old process deleting a newer process's lock.
        await this.options.redis
          .eval(RELEASE_LOCK, 1, lockKey, lockId)
          .catch((err) =>
            this.logger.error({ err }, 'copy-trade lock release failed; expires automatically'),
          );
      }
    }
  }
}
