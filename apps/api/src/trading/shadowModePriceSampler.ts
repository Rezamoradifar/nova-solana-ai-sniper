import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { DexScreenerClient, DexScreenerPair } from '../solana/dexscreener.js';

/**
 * Shadow-mode price sampling (Sections 3-4, 2026-07-22). Independent of
 * priceMonitor.ts, which is scoped to OPEN positions and pulls in unrelated
 * wallet-decryption/exit-execution concerns — this is pure background
 * observation, reusing the shared DexScreenerClient (already cached/
 * deduped/timeout-bounded) so it can never affect the live-trading hot path.
 * Batches its DB read on an interval rather than a per-token timer, so
 * thousands of shadow rows don't mean thousands of independent timers.
 */

export interface PriceOffsetSpec {
  field: 'price5mUsd' | 'price15mUsd' | 'price1hUsd' | 'price4hUsd' | 'price24hUsd';
  ms: number;
}

export const PRICE_SAMPLE_OFFSETS: readonly PriceOffsetSpec[] = [
  { field: 'price5mUsd', ms: 5 * 60 * 1000 },
  { field: 'price15mUsd', ms: 15 * 60 * 1000 },
  { field: 'price1hUsd', ms: 60 * 60 * 1000 },
  { field: 'price4hUsd', ms: 4 * 60 * 60 * 1000 },
  { field: 'price24hUsd', ms: 24 * 60 * 60 * 1000 },
];

/** Every offset whose time has passed and isn't already filled — a poller
 * with gaps between ticks still catches up on every due offset at once,
 * rather than only ever advancing one step per tick. */
export function computeDueOffsets(
  detectedAt: Date,
  now: number,
  alreadyFilled: ReadonlySet<string>,
): PriceOffsetSpec[] {
  const elapsedMs = now - detectedAt.getTime();
  return PRICE_SAMPLE_OFFSETS.filter((o) => !alreadyFilled.has(o.field) && elapsedMs >= o.ms);
}

/** Same liquidity floor RiskAnalyzer already uses for isHoneypotSuspected —
 * a pair that vanished entirely (DexScreener returns nothing) or whose
 * liquidity collapsed toward zero is treated as "this would have rugged." */
export const RUG_LIQUIDITY_FLOOR_USD = 500;

export function isLikelyRugFromSample(pair: DexScreenerPair | undefined): boolean {
  if (!pair) return true;
  return (pair.liquidity?.usd ?? 0) < RUG_LIQUIDITY_FLOOR_USD;
}

/** Wallet entries older than this with no exit signal are marked EXPIRED
 * (their unrealizedRoiPercent becomes a "resolved" outcome for
 * computeWalletConfidence purposes) — this codebase has no way to observe an
 * arbitrary tracked wallet's own sell, so an entry can otherwise stay OPEN
 * forever. 7 days is generous for a meme-coin-timescale evaluation. */
export const WALLET_ENTRY_EVALUATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_POLL_INTERVAL_MS = 90_000;
const BATCH_SIZE = 200;

export interface ShadowModePriceSamplerDeps {
  prisma: PrismaClient;
  dexScreener: DexScreenerClient;
  logger: Logger;
}

export class ShadowModePriceSampler {
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: ShadowModePriceSamplerDeps) {}

  start(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    await Promise.allSettled([this.sampleShadowLogs(), this.sampleWalletEntries()]);
  }

  private async sampleShadowLogs(): Promise<void> {
    const rows = await this.deps.prisma.shadowModeDecisionLog.findMany({
      where: { sampledAt24h: null },
      take: BATCH_SIZE,
    });

    for (const row of rows) {
      try {
        const filled = new Set<string>();
        if (row.price5mUsd !== null) filled.add('price5mUsd');
        if (row.price15mUsd !== null) filled.add('price15mUsd');
        if (row.price1hUsd !== null) filled.add('price1hUsd');
        if (row.price4hUsd !== null) filled.add('price4hUsd');
        if (row.price24hUsd !== null) filled.add('price24hUsd');

        const due = computeDueOffsets(row.detectedAt, Date.now(), filled);
        if (due.length === 0) continue;

        const pair = await this.deps.dexScreener.getBestSolanaPair(row.mint);
        const priceUsd = pair?.priceUsd !== undefined ? Number(pair.priceUsd) : null;
        const rugLikely = isLikelyRugFromSample(pair);

        const data: Record<string, unknown> = {};
        for (const offset of due) data[offset.field] = priceUsd;
        if (rugLikely) data.wasRugOrScamBySample = true;
        if (due.some((o) => o.field === 'price24hUsd')) data.sampledAt24h = new Date();

        await this.deps.prisma.shadowModeDecisionLog.update({ where: { id: row.id }, data });
      } catch (err) {
        this.deps.logger.debug(
          { mint: row.mint, err },
          'shadowModePriceSampler: shadow log sample failed',
        );
      }
    }
  }

  private async sampleWalletEntries(): Promise<void> {
    const rows = await this.deps.prisma.smartWalletTokenEntry.findMany({
      where: { status: 'OPEN' },
      take: BATCH_SIZE,
    });
    const expiryCutoff = Date.now() - WALLET_ENTRY_EVALUATION_WINDOW_MS;

    for (const row of rows) {
      try {
        const pair = await this.deps.dexScreener.getBestSolanaPair(row.mint);
        const priceUsd = pair?.priceUsd !== undefined ? Number(pair.priceUsd) : undefined;
        const rugLikely = isLikelyRugFromSample(pair);
        const unrealizedRoiPercent =
          priceUsd !== undefined && row.entryPriceUsd
            ? ((priceUsd - row.entryPriceUsd) / row.entryPriceUsd) * 100
            : undefined;
        const expired = row.entryAt.getTime() < expiryCutoff;

        await this.deps.prisma.smartWalletTokenEntry.update({
          where: { id: row.id },
          data: {
            lastMarkPriceUsd: priceUsd,
            lastMarkAt: new Date(),
            unrealizedRoiPercent,
            isRugOrScam: rugLikely || row.isRugOrScam,
            status: rugLikely ? 'RUG_FLAGGED' : expired ? 'EXPIRED' : 'OPEN',
          },
        });
      } catch (err) {
        this.deps.logger.debug(
          { mint: row.mint, walletAddress: row.walletAddress, err },
          'shadowModePriceSampler: wallet entry sample failed',
        );
      }
    }
  }
}
