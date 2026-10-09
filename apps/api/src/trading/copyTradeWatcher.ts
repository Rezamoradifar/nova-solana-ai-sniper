import {
  LAMPORTS_PER_SOL,
  PublicKey,
  type Connection,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Logger } from '@nova/shared';
import type { CopyTradingService } from './copyTrading.js';
import { PUMPFUN_PROGRAM_ID } from '../solana/pumpfun.js';
import { PUMPSWAP_PROGRAM_ID } from '../solana/dex/pumpswap.js';
import { RAYDIUM_CPMM_PROGRAM_ID } from '../solana/dex/raydium.js';
import { ORCA_WHIRLPOOL_PROGRAM_ID } from '../solana/dex/orca.js';
import { METEORA_DLMM_PROGRAM_ID } from '../solana/dex/meteora.js';

const SWAP_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  ...[
    PUMPFUN_PROGRAM_ID,
    PUMPSWAP_PROGRAM_ID,
    RAYDIUM_CPMM_PROGRAM_ID,
    ORCA_WHIRLPOOL_PROGRAM_ID,
    METEORA_DLMM_PROGRAM_ID,
  ].map((id) => id.toBase58()),
]);

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
  if (!tx.meta || tx.meta.err !== null) return undefined;
  const accountIndex = tx.transaction.message.accountKeys.findIndex(
    (key) => key.signer && key.pubkey?.toBase58() === targetAddress,
  );
  if (accountIndex < 0) return undefined;
  const instructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
  if (!instructions.some((ix) => SWAP_PROGRAMS.has(ix.programId.toBase58()))) return undefined;
  const preLamports = tx.meta.preBalances[accountIndex];
  const postLamports = tx.meta.postBalances[accountIndex];
  if (!Number.isFinite(preLamports) || !Number.isFinite(postLamports)) return undefined;
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  const owned = [...pre, ...post].filter((row) => row.owner === targetAddress);
  const mints = new Set(owned.map((row) => row.mint));
  const amount = (rows: typeof pre, mint: string) =>
    rows
      .filter((row) => row.owner === targetAddress && row.mint === mint)
      .reduce(
        (sum, row) => sum + Number(row.uiTokenAmount.uiAmountString ?? row.uiTokenAmount.uiAmount),
        0,
      );
  const gains: string[] = [];
  for (const mint of mints) {
    if (mint === WSOL_MINT) continue;
    const delta = amount(post, mint) - amount(pre, mint);
    if (!Number.isFinite(delta)) return undefined;
    // SOL-funded single-asset swaps only; reject token-funded swaps and ambiguous baskets.
    if (delta < 0 || ((mint === USDC_MINT || mint === USDT_MINT) && delta !== 0)) return undefined;
    if (delta > 0) gains.push(mint);
  }
  if (gains.length !== 1) return undefined;
  let rentChange = 0;
  for (const index of new Set(owned.map((row) => row.accountIndex))) {
    const row = owned.find((item) => item.accountIndex === index)!;
    if (row.mint === WSOL_MINT) continue;
    rentChange += (tx.meta.postBalances[index] ?? 0) - (tx.meta.preBalances[index] ?? 0);
  }
  const amountSolOriginal =
    (preLamports! - postLamports! - (accountIndex === 0 ? tx.meta.fee : 0) - rentChange) /
      LAMPORTS_PER_SOL +
    amount(pre, WSOL_MINT) -
    amount(post, WSOL_MINT);
  if (!Number.isFinite(amountSolOriginal) || amountSolOriginal < minSourceBuySol) return undefined;
  return { mint: gains[0]!, amountSolOriginal };
}

export interface CopyTradeWatcherDeps {
  prisma: PrismaClient;
  redis: Redis;
  connection: Connection;
  copyTrading: CopyTradingService;
  logger: Logger;
  pollIntervalMs: number;
  maxSignalAgeMs: number;
  minSourceBuySol: number;
}

export class CopyTradeWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private cursor = 0;
  private tickHadError = false;
  private lastSuccessAt: number | null = null;
  private lastErrorAt: number | null = null;

  getStatus() {
    return {
      running: Boolean(this.timer),
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      healthy:
        Boolean(this.timer) &&
        this.lastSuccessAt !== null &&
        Date.now() - this.lastSuccessAt < Math.max(60_000, this.deps.pollIntervalMs * 4) &&
        (this.lastErrorAt === null || this.lastSuccessAt > this.lastErrorAt),
    };
  }

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
      this.tickHadError = false;
      await this.tickInner();
      if (!this.tickHadError) this.lastSuccessAt = Date.now();
    } catch (error) {
      this.lastErrorAt = Date.now();
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
      orderBy: { targetAddress: 'asc' },
    });
    const targets = [...new Set(configs.map((row) => row.targetAddress))];
    if (targets.length === 0) return;

    const internal = await this.deps.prisma.wallet.findMany({
      where: { publicKey: { in: targets } },
      select: { publicKey: true },
    });
    const excluded = new Set(internal.map((w) => w.publicKey));
    const external = targets.filter((address) => !excluded.has(address));
    // Bounded RPC work, rotating so a busy/failed first wallet cannot starve later targets.
    const batch = Array.from(
      { length: Math.min(10, external.length) },
      (_, i) => external[(this.cursor + i) % external.length]!,
    );
    this.cursor = external.length ? (this.cursor + batch.length) % external.length : 0;
    for (const targetAddress of batch) {
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
        this.tickHadError = true;
        this.lastErrorAt = Date.now();
        this.deps.logger.warn({ targetAddress, error }, 'copy trade target history read failed');
        continue;
      }

      for (const row of [...signatures].reverse()) {
        if (row.err) continue;
        const timestampMs = (row.blockTime ?? 0) * 1000;
        if (
          !timestampMs ||
          timestampMs > Date.now() + 5000 ||
          Date.now() - timestampMs > this.deps.maxSignalAgeMs
        )
          continue;

        const seenKey = `copy-trade:seen:${targetAddress}:${row.signature}`;
        if (await this.deps.redis.exists(seenKey)) continue;

        const tx = await this.deps.connection
          .getParsedTransaction(row.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          })
          .catch(() => {
            this.tickHadError = true;
            this.lastErrorAt = Date.now();
            return null;
          });
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
          observedAt: timestampMs,
        });
        await this.deps.redis.set(seenKey, 'done', 'EX', SEEN_TTL_SECONDS);
      }
    }
  }
}
