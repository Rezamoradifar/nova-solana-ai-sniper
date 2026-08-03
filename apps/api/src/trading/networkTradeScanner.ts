import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { Redis } from 'ioredis';
import type { DexScreenerClient } from '../solana/dexscreener.js';
import type { SmartWalletTrackerService } from './smartWalletTracker.js';

/**
 * Network Trade Scanner (2026-08-02) — broadens WHICH mints
 * SmartWalletTrackerService.evaluateForToken gets called for, beyond the live
 * pre-migration pump.fun candidate pipeline (smartMoneyMomentumEvaluator.ts)
 * that's its only caller today. evaluateForToken itself is untouched — its
 * buy-side detection (extractBuyerFromTransaction) reads token/SOL balance
 * deltas off a parsed transaction, not any pump.fun-specific instruction, so
 * it already works for any DEX. The Token table already has real,
 * on-chain-discovered rows across PUMPFUN/PUMPSWAP/RAYDIUM/ORCA/METEORA/
 * JUPITER (see this feature's own plan doc) — this scanner just feeds a
 * bounded, rotating slice of those mints through the existing, tested
 * pipeline so SmartWalletTokenEntry rows (and eventually, via
 * ShadowModePriceSampler's existing DEX-agnostic checkAndRecordExit, real
 * EXITED rows) start existing for more than pump.fun.
 *
 * Never touches buy/sell execution — same isolation contract as
 * ShadowModePriceSampler. Fails open on every per-mint error (matches
 * evaluateForToken's own "never throw into the pipeline" contract).
 */

/** Once a mint has been scanned, it's skipped for this long — bounds repeat
 * RPC burn on the same mint as the candidate pool rotates each tick, without
 * needing a new DB column to track a per-mint cursor. */
const RESCAN_COOLDOWN_SECONDS = 6 * 60 * 60;

function redisScanKey(mint: string): string {
  return `network-trade-scanner:scanned:${mint}`;
}

export interface NetworkTradeScannerDeps {
  prisma: PrismaClient;
  dexScreener: DexScreenerClient;
  smartWalletTracker: SmartWalletTrackerService;
  redis: Redis;
  logger: Logger;
  batchSize: number;
  minLiquidityUsd: number;
  /** Rolling window a token's `firstSeenAt` (discovery time, NOT last-trade
   * time) must fall within to stay eligible for a scan — bounds query size,
   * same rationale as activityFeed's MARKET_ACTIVITY_LOOKBACK_HOURS. Discovery
   * recency is a proxy, not the real gate: evaluateForToken always reads
   * whatever the mint's OWN most-recent on-chain signatures are, so a token
   * discovered outside this window but still genuinely trading today is
   * simply never offered as a candidate — widen this (env-configurable,
   * NETWORK_TRADE_SCANNER_LOOKBACK_HOURS) if the live discovery pipeline
   * falls behind and the default 48h leaves too few real candidates. */
  tokenLookbackHours: number;
}

export class NetworkTradeScannerService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly deps: NetworkTradeScannerDeps) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickInner();
    } catch (err) {
      this.deps.logger.error({ err }, 'networkTradeScanner: tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Real, recently-active tokens across every DEX the bot has ever
   * discovered — no `dex` filter is the whole point (see this module's own
   * doc comment). Over-fetches (4x batch) so the not-yet-scanned filter below
   * still has enough candidates left after skipping recently-scanned mints. */
  private async fetchCandidateMints(): Promise<{ id: string; mint: string }[]> {
    const windowStart = new Date(Date.now() - this.deps.tokenLookbackHours * 60 * 60 * 1000);
    return this.deps.prisma.token.findMany({
      where: {
        firstSeenAt: { gte: windowStart },
        liquidityUsd: { gte: this.deps.minLiquidityUsd },
      },
      orderBy: { firstSeenAt: 'desc' },
      take: this.deps.batchSize * 4,
      select: { id: true, mint: true },
    });
  }

  /** Real-only price proxy — same "sampled at evaluation time" honesty
   * convention already documented on recordTokenEntry's approxEntryPriceUsd
   * param. undefined (never fabricated) on any lookup failure. */
  private async fetchApproxPriceUsd(mint: string): Promise<number | undefined> {
    try {
      const pair = await this.deps.dexScreener.getBestSolanaPair(mint);
      const price = pair?.priceUsd !== undefined ? Number(pair.priceUsd) : undefined;
      return price !== undefined && Number.isFinite(price) ? price : undefined;
    } catch {
      return undefined;
    }
  }

  private async tickInner(): Promise<void> {
    const candidates = await this.fetchCandidateMints();
    if (candidates.length === 0) return;

    let scanned = 0;
    for (const candidate of candidates) {
      if (scanned >= this.deps.batchSize) break;
      // SET ... NX EX — atomic claim, doubles as the rescan-cooldown guard.
      const claimed = await this.deps.redis
        .set(redisScanKey(candidate.mint), '1', 'EX', RESCAN_COOLDOWN_SECONDS, 'NX')
        .catch(() => null);
      if (claimed !== 'OK') continue;
      scanned += 1;

      const approxEntryPriceUsd = await this.fetchApproxPriceUsd(candidate.mint);
      try {
        await this.deps.smartWalletTracker.evaluateForToken(
          candidate.mint,
          candidate.id,
          undefined,
          approxEntryPriceUsd,
        );
      } catch (err) {
        this.deps.logger.debug(
          { mint: candidate.mint, err },
          'networkTradeScanner: evaluateForToken failed — non-fatal',
        );
      }
    }

    if (scanned > 0) {
      this.deps.logger.debug({ scanned }, 'networkTradeScanner: tick complete');
    }
  }
}
