import { PublicKey, type Connection } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { getKillSwitchState, type Logger } from '@nova/shared';

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface SafetyConfig {
  maxTradeSol: number;
  maxDailyLossUsd: number;
  maxOpenPositions: number;
  minWalletReserveSol: number;
  /** Restart-required hard override, independent of the Redis-backed kill switch. */
  killSwitchEnv: boolean;
}

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
  /** Set only by evaluateWalletBalance's failing branch — lets a caller (e.g.
   * AutoTrader's low-balance notification) act on the specific gate that
   * fired without parsing the human-readable `reason` string back apart. */
  code?: 'wallet_balance';
  details?: { balanceSol: number; requiredSol: number };
}

export class SafetyCheckError extends Error {
  constructor(
    public readonly reason: string,
    public readonly code?: SafetyCheckResult['code'],
    public readonly details?: SafetyCheckResult['details'],
  ) {
    super(`Trade blocked by safety check: ${reason}`);
    this.name = 'SafetyCheckError';
  }
}

// --- Pure decision logic — no I/O, exhaustively unit-tested in safety.test.ts ---

export function evaluateKillSwitch(active: boolean): SafetyCheckResult {
  if (active) {
    return {
      allowed: false,
      reason: 'Emergency kill switch is active — all new trades are halted',
    };
  }
  return { allowed: true };
}

export function evaluatePerTradeLimit(amountSol: number, maxTradeSol: number): SafetyCheckResult {
  if (amountSol > maxTradeSol) {
    return {
      allowed: false,
      reason: `Trade size ${amountSol} SOL exceeds the per-trade limit of ${maxTradeSol} SOL`,
    };
  }
  return { allowed: true };
}

export function evaluateDailyLossLimit(
  realizedPnlUsdToday: number,
  maxDailyLossUsd: number,
): SafetyCheckResult {
  if (realizedPnlUsdToday <= -Math.abs(maxDailyLossUsd)) {
    return {
      allowed: false,
      reason: `Daily loss limit reached ($${realizedPnlUsdToday.toFixed(2)} realized today, limit -$${maxDailyLossUsd.toFixed(2)})`,
    };
  }
  return { allowed: true };
}

export function evaluateMaxOpenPositions(
  openCount: number,
  maxOpenPositions: number,
): SafetyCheckResult {
  if (openCount >= maxOpenPositions) {
    return {
      allowed: false,
      reason: `Max open positions reached (${openCount}/${maxOpenPositions})`,
    };
  }
  return { allowed: true };
}

/**
 * Two detection events for the same token (e.g. a redelivered websocket log, or
 * two independent detection sources both reaching evaluateAndMaybeBuy around the
 * same moment) could otherwise both pass every other check and open two real,
 * independent positions in the same token for the same wallet — a live-money
 * double-spend, not just noise.
 */
export function evaluateDuplicateOpenPosition(alreadyOpenForToken: boolean): SafetyCheckResult {
  if (alreadyOpenForToken) {
    return {
      allowed: false,
      reason: 'An OPEN position already exists for this token in this wallet',
    };
  }
  return { allowed: true };
}

export function evaluateWalletBalance(
  balanceSol: number,
  tradeAmountSol: number,
  reserveSol: number,
): SafetyCheckResult {
  const required = tradeAmountSol + reserveSol;
  if (balanceSol < required) {
    return {
      allowed: false,
      reason: `Wallet balance ${balanceSol.toFixed(4)} SOL is below the ${required.toFixed(4)} SOL required (trade + fee reserve)`,
      code: 'wallet_balance',
      details: { balanceSol, requiredSol: required },
    };
  }
  return { allowed: true };
}

/** Sanity-checks the safety config itself — a misconfigured limit shouldn't silently no-op. */
export function evaluateSafetyConfig(config: SafetyConfig): string[] {
  const errors: string[] = [];
  if (!(config.maxTradeSol > 0)) errors.push('MAX_TRADE_SOL must be a positive number');
  if (!(config.maxDailyLossUsd > 0)) errors.push('MAX_DAILY_LOSS_USD must be a positive number');
  if (!(Number.isInteger(config.maxOpenPositions) && config.maxOpenPositions >= 1)) {
    errors.push('MAX_OPEN_POSITIONS must be a positive integer');
  }
  if (!(config.minWalletReserveSol >= 0)) errors.push('MIN_WALLET_RESERVE_SOL must be >= 0');
  return errors;
}

export interface SafetyReadiness {
  ready: boolean;
  errors: string[];
}

/**
 * Confirms the safety system is actually functional before trusting LIVE_TRADING=true.
 * Checked at worker startup — if this fails, live trading is refused and the position
 * manager falls back to paper mode regardless of the env flag.
 */
export async function verifySafetySystemReady(
  config: SafetyConfig,
  redis: Redis,
): Promise<SafetyReadiness> {
  const errors = evaluateSafetyConfig(config);

  try {
    await redis.ping();
  } catch (err) {
    errors.push(
      `Redis is unreachable — the kill switch cannot be enforced (${(err as Error).message})`,
    );
  }

  return { ready: errors.length === 0, errors };
}

// --- I/O wrapper: fetches the numbers the pure functions above need to decide on ---

export interface CheckOpenParams {
  userId: string;
  walletId: string;
  walletPublicKey: string;
  amountSol: number;
  tokenId: string;
}

export class TradingSafety {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly connection: Connection,
    private readonly config: SafetyConfig,
    private readonly logger: Logger,
  ) {}

  /** Fails closed: if Redis can't be reached, treat the kill switch as active rather than silently allowing trades. */
  async isKillSwitchActive(): Promise<boolean> {
    if (this.config.killSwitchEnv) return true;
    try {
      return await getKillSwitchState(this.redis);
    } catch (err) {
      this.logger.error({ err }, 'kill switch check failed — failing closed (blocking new trades)');
      return true;
    }
  }

  private async dailyRealizedPnlUsd(userId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const closedToday = await this.prisma.position.findMany({
      where: { status: 'CLOSED', closedAt: { gte: startOfDay }, wallet: { userId } },
      select: { realizedPnlUsd: true },
    });
    return closedToday.reduce((sum, p) => sum + (p.realizedPnlUsd ?? 0), 0);
  }

  private async openPositionCount(walletId: string): Promise<number> {
    return this.prisma.position.count({ where: { walletId, status: 'OPEN' } });
  }

  private async hasOpenPositionForToken(walletId: string, tokenId: string): Promise<boolean> {
    const existing = await this.prisma.position.findFirst({
      where: { walletId, tokenId, status: 'OPEN' },
      select: { id: true },
    });
    return existing !== null;
  }

  private async walletBalanceSol(publicKey: string): Promise<number> {
    const lamports = await this.connection.getBalance(new PublicKey(publicKey));
    return lamports / LAMPORTS_PER_SOL;
  }

  /**
   * Runs every applicable check before opening a new position, short-circuiting on the
   * first failure. The on-chain balance check only runs for real (non-paper) trades.
   */
  async checkBeforeOpen(
    params: CheckOpenParams,
    { isLive }: { isLive: boolean },
  ): Promise<SafetyCheckResult> {
    const killSwitch = evaluateKillSwitch(await this.isKillSwitchActive());
    if (!killSwitch.allowed) return killSwitch;

    const perTrade = evaluatePerTradeLimit(params.amountSol, this.config.maxTradeSol);
    if (!perTrade.allowed) return perTrade;

    const dailyPnl = await this.dailyRealizedPnlUsd(params.userId);
    const dailyLoss = evaluateDailyLossLimit(dailyPnl, this.config.maxDailyLossUsd);
    if (!dailyLoss.allowed) return dailyLoss;

    const openCount = await this.openPositionCount(params.walletId);
    const maxPositions = evaluateMaxOpenPositions(openCount, this.config.maxOpenPositions);
    if (!maxPositions.allowed) return maxPositions;

    const alreadyOpenForToken = await this.hasOpenPositionForToken(params.walletId, params.tokenId);
    const duplicate = evaluateDuplicateOpenPosition(alreadyOpenForToken);
    if (!duplicate.allowed) return duplicate;

    if (isLive) {
      const balance = await this.walletBalanceSol(params.walletPublicKey);
      const balanceCheck = evaluateWalletBalance(
        balance,
        params.amountSol,
        this.config.minWalletReserveSol,
      );
      if (!balanceCheck.allowed) return balanceCheck;
    }

    return { allowed: true };
  }
}
