import type { Connection } from '@solana/web3.js';
import type { PrismaClient, Dex } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';
import { getBondingCurveState } from '../solana/pumpfunBondingCurve.js';
import type { DexScreenerClient } from '../solana/dexscreener.js';
import { eventBus } from '../lib/eventBus.js';

/**
 * Maps a DexScreener `dexId` string to our `Dex` enum. Returns undefined rather
 * than guessing on an unrecognized id — an unmapped venue should be retried
 * later (DexScreener may just not have indexed it yet), not misfiled.
 */
export function mapDexIdToDex(dexId: string | undefined): Dex | undefined {
  if (!dexId) return undefined;
  const id = dexId.toLowerCase();
  if (id === 'pumpfun') return 'PUMPFUN';
  if (id === 'pumpswap') return 'PUMPSWAP';
  if (id.startsWith('raydium')) return 'RAYDIUM';
  if (id.startsWith('orca')) return 'ORCA';
  if (id.startsWith('meteora')) return 'METEORA';
  if (id === 'jupiter') return 'JUPITER';
  return undefined;
}

export interface MigrationMonitorDeps {
  prisma: PrismaClient;
  connection: Connection;
  dexScreener: DexScreenerClient;
  logger: Logger;
  notifier?: NotificationService;
}

// pump.fun graduation (if it happens at all) happens quickly relative to a token's
// lifetime — bounding the poll set to recently-seen tokens keeps this from growing
// unbounded as the platform's all-time token count grows.
const MAX_TOKEN_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * Polls every recently-seen pump.fun token's bonding curve account for its `complete`
 * flag — the ground-truth on-chain migration signal (verified against live mainnet
 * data: this codebase already decodes and trusts this exact field for liquidity
 * estimation). This is deliberately not driven by log-parsing a specific pump.fun
 * instruction: live sampling this session found no single reliable "migration just
 * happened" log line (the real event is rare relative to overall program traffic,
 * and pump.fun's own instruction set includes look-alike names — e.g.
 * `MigrateBondingCurveCreator` — that are unrelated fee-config admin calls, not
 * liquidity migrations). `checkOne` is also called directly as a fast-path for the
 * best-effort log hint pump.fun's monitor still provides, so a real migration is
 * caught immediately rather than waiting for the next poll tick when possible.
 */
export class MigrationMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly deps: MigrationMonitorDeps) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const candidates = await this.deps.prisma.token.findMany({
        where: { dex: 'PUMPFUN', createdAt: { gt: new Date(Date.now() - MAX_TOKEN_AGE_MS) } },
      });
      for (const token of candidates) {
        await this.checkOne(token.id, token.mint).catch((err) => {
          this.deps.logger.error({ err, mint: token.mint }, 'migration check failed');
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Checks a single mint immediately. Returns true if a migration was recorded. */
  async checkOne(tokenId: string, mint: string): Promise<boolean> {
    const state = await getBondingCurveState(this.deps.connection, mint).catch((err: unknown) => {
      this.deps.logger.debug({ mint, err }, 'bonding curve read failed during migration check');
      return undefined;
    });

    // Only the explicit `complete` flag counts as migrated — an unreadable account
    // could just be a transient RPC hiccup, not proof the curve is gone.
    if (!state || !state.complete) return false;

    const pair = await this.deps.dexScreener.getBestSolanaPair(mint).catch(() => undefined);
    const newDex = mapDexIdToDex(pair?.dexId);
    if (!newDex || newDex === 'PUMPFUN') {
      this.deps.logger.warn(
        { mint, dexId: pair?.dexId },
        'bonding curve reports migrated but the new venue could not be confidently resolved yet — will retry',
      );
      return false;
    }

    const updated = await this.deps.prisma.token.update({
      where: { id: tokenId },
      data: { dex: newDex, poolAddress: pair?.pairAddress },
    });

    this.deps.logger.info({ mint, from: 'PUMPFUN', to: newDex }, 'token migrated off pump.fun');
    eventBus.publish('token.migrated', { tokenId, mint, from: 'PUMPFUN', to: newDex });
    await this.deps.notifier?.notifyMigration({
      mint,
      symbol: updated.symbol ?? undefined,
      fromDex: 'PUMPFUN',
      toDex: newDex,
    });
    return true;
  }
}
