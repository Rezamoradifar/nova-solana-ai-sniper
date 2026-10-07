import { LAMPORTS_PER_SOL, PublicKey, type Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Logger } from '@nova/shared';
import type { DexScreenerClient } from '../solana/dexscreener.js';
import type { CopyTradingService } from './copyTrading.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface DetectedCopyBuy {
  mint: string;
  amountSolOriginal: number;
}

export function detectCopyBuy(
  tx: ParsedTransactionWithMeta,
  targetAddress: string,
  minSourceBuySol: number,
): DetectedCopyBuy | undefined {
  const accountIndex = tx.transaction.message.accountKeys.findIndex(
    (key) => key.pubkey?.toBase58() === targetAddress,
  );
  if (accountIndex < 0) return undefined;

  const preLamports = tx.meta?.preBalances?.[accountIndex];
  const postLamports = tx.meta?.postBalances?.[accountIndex];
  if (preLamports === undefined || postLamports === undefined) return undefined;
  const amountSolOriginal = (preLamports - postLamports) / LAMPORTS_PER_SOL;
  if (!Number.isFinite(amountSolOriginal) || amountSolOriginal < minSourceBuySol) return undefined;

  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const mints = new Set(
    post.filter((row) => row.owner === targetAddress).map((row) => row.mint),
  );

  let best: { mint: string; delta: number } | undefined;
  for (const mint of mints) {
    if (mint === WSOL_MINT || mint === USDC_MINT || mint === USDT_MINT) continue;
    const preAmount = pre
      .filter((row) => row.owner === targetAddress && row.mint === mint)
      .reduce((sum, row) => sum + (row.uiTokenAmount.uiAmount ?? 0), 0);
    const postAmount = post
      .filter((row) => row.owner === targetAddress && row.mint === mint)
      .reduce((sum, row) => sum + (row.uiTokenAmount.uiAmount ?? 0), 0);
    const delta = postAmount - preAmount;
    if (delta <= 0) continue;
    if (!best || delta > best.delta) best = { mint, delta };
  }

  return best ? { mint: best.mint, amountSolOriginal } : undefined;
}

export interface CopyTradeWatcherDeps {
  prisma: PrismaClient;
  redis: Redis;
  connection: Connection;
  dexScreener: DexScreenerClient;
  copyTrading: CopyTradingService;
  logger: Logger;
  pollIntervalMs: number;
  maxSignalAgeMs: number;
  minSourceBuySol: number;
}

export class CopyTradeWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly deps: CopyTradeWatcherDeps) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.deps.pollIntervalMs);
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
    } catch (error) {
      this.deps.logger.error({ error }, 'copyTradeWatcher tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner(): Promise<void> {
    const configs = await this.deps.prisma.copyTradeConfig.findMany({
      where: {
        isActive: true,
        user: { isSuspended: false, deletedAt: null },
      },
      select: { targetAddress: true },
    });
    const targets = [...new Set(configs.map((row) => row.targetAddress))];
    if (targets.length === 0) return;

    for (const targetAddress of targets) {
      let publicKey: PublicKey;
      try {
        publicKey = new PublicKey(targetAddress);
      } catch {
        this.deps.logger.warn({ targetAddress }, 'copy trade target is not a valid Solana address');
        continue;
      }

      let signatures;
      try {
        signatures = await this.deps.connection.getSignaturesForAddress(
          publicKey,
          { limit: 8 },
          'confirmed',
        );
      } catch (error) {
        this.deps.logger.warn({ targetAddress, error }, 'copy trade target history read failed');
        continue;
      }

      for (const row of [...signatures].reverse()) {
        if (row.err) continue;
        const timestampMs = (row.blockTime ?? 0) * 1000;
        if (!timestampMs || Date.now() - timestampMs > this.deps.maxSignalAgeMs) continue;

        const seenKey = `copy-trade:seen:${targetAddress}:${row.signature}`;
        if (await this.deps.redis.exists(seenKey)) continue;

        const tx = await this.deps.connection
          .getParsedTransaction(row.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          })
          .catch(() => null);
        if (!tx) continue;

        const detected = detectCopyBuy(tx, targetAddress, this.deps.minSourceBuySol);
        if (!detected) {
          await this.deps.redis.set(seenKey, 'ignored', 'EX', SEEN_TTL_SECONDS);
          continue;
        }

        const token = await this.deps.prisma.token.findUnique({
          where: { mint: detected.mint },
          select: { id: true, mint: true },
        });
        if (!token) {
          // Never mirror an unknown mint. It must first pass GSP discovery/risk
          // ingestion and exist in Token, so copy trading cannot become a bypass.
          await this.deps.redis.set(seenKey, 'unknown-token', 'EX', SEEN_TTL_SECONDS);
          continue;
        }

        const pair = await this.deps.dexScreener.getBestSolanaPair(token.mint).catch(() => undefined);
        const entryPriceUsd =
          pair?.priceUsd !== undefined && Number.isFinite(Number(pair.priceUsd))
            ? Number(pair.priceUsd)
            : 0;

        const claimed = await this.deps.redis.set(
          seenKey,
          'processing',
          'EX',
          SEEN_TTL_SECONDS,
          'NX',
        );
        if (claimed !== 'OK') continue;

        this.deps.logger.info(
          {
            targetAddress,
            signature: row.signature,
            mint: token.mint,
            sourceBuySol: detected.amountSolOriginal,
          },
          'fresh copy-trade buy detected',
        );

        await this.deps.copyTrading.mirror({
          targetAddress,
          mint: token.mint,
          tokenId: token.id,
          amountSolOriginal: detected.amountSolOriginal,
          entryPriceUsd,
        });
        await this.deps.redis.set(seenKey, 'done', 'EX', SEEN_TTL_SECONDS);
      }
    }
  }
}
