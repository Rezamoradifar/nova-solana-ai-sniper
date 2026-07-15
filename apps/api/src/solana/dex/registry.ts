import type { Connection, ParsedTransactionWithMeta } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { Logger } from '@nova/shared';
import type { Dex } from '@prisma/client';
import { SolPriceOracle, sharedSolPriceOracle } from '../pumpfunBondingCurve.js';
import type { DexScreenerClient } from '../dexscreener.js';
import {
  PUMPSWAP_PROGRAM_ID,
  PumpSwapMonitor,
  getPumpSwapLiquidity,
  getPumpSwapPoolState,
} from './pumpswap.js';
import {
  RAYDIUM_CPMM_PROGRAM_ID,
  RaydiumCpmmMonitor,
  getRaydiumCpmmLiquidity,
  getRaydiumCpmmPoolState,
} from './raydium.js';
import {
  ORCA_WHIRLPOOL_PROGRAM_ID,
  OrcaWhirlpoolMonitor,
  getOrcaWhirlpoolLiquidity,
  getOrcaWhirlpoolState,
} from './orca.js';
import {
  METEORA_DLMM_PROGRAM_ID,
  MeteoraDlmmMonitor,
  getMeteoraDlmmLiquidity,
  getMeteoraDlmmPoolState,
} from './meteora.js';
import {
  NotImplementedNativeExecutor,
  type DexMonitor,
  type DexPoolInfo,
  type NativeDexExecutor,
  type NativeDexName,
} from './types.js';

type NativeDex = NativeDexName;

const PROGRAM_ID_BY_DEX: Record<NativeDex, PublicKey> = {
  PUMPSWAP: PUMPSWAP_PROGRAM_ID,
  RAYDIUM: RAYDIUM_CPMM_PROGRAM_ID,
  ORCA: ORCA_WHIRLPOOL_PROGRAM_ID,
  METEORA: METEORA_DLMM_PROGRAM_ID,
};

// Cheap to skip outright — never a newly-created pool account, no point paying an
// RPC round trip to find that out for every transaction scanned.
const NEVER_A_POOL_ACCOUNT = new Set([
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'So11111111111111111111111111111111111111112',
  'SysvarRent111111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111',
]);

type LiquidityReader = (
  connection: Connection,
  dexScreener: DexScreenerClient,
  solPriceOracle: SolPriceOracle,
  poolAddress: string,
) => Promise<DexPoolInfo | undefined>;

/**
 * One place that knows about every non-Jupiter DEX integration, so worker.ts and
 * positionManager.ts don't need a per-DEX conditional each — adding a real native
 * executor for Raydium/Orca/Meteora later (currently `NotImplementedNativeExecutor`
 * stubs) is a change to this file's construction only, not to any call site.
 */
export class DexRegistry {
  readonly monitors: ReadonlyMap<NativeDex, DexMonitor>;
  private readonly liquidityReaders: ReadonlyMap<NativeDex, LiquidityReader>;
  private readonly executors: ReadonlyMap<NativeDex, NativeDexExecutor>;
  private readonly solPriceOracle: SolPriceOracle = sharedSolPriceOracle;

  constructor(
    private readonly connection: Connection,
    private readonly dexScreener: DexScreenerClient,
    logger: Logger,
    executorOverrides: Partial<Record<NativeDex, NativeDexExecutor>> = {},
  ) {
    this.monitors = new Map<NativeDex, DexMonitor>([
      ['PUMPSWAP', new PumpSwapMonitor(connection, logger)],
      ['RAYDIUM', new RaydiumCpmmMonitor(connection, logger)],
      ['ORCA', new OrcaWhirlpoolMonitor(connection, logger)],
      ['METEORA', new MeteoraDlmmMonitor(connection, logger)],
    ]);
    this.liquidityReaders = new Map<NativeDex, LiquidityReader>([
      ['PUMPSWAP', getPumpSwapLiquidity],
      ['RAYDIUM', getRaydiumCpmmLiquidity],
      ['ORCA', getOrcaWhirlpoolLiquidity],
      ['METEORA', getMeteoraDlmmLiquidity],
    ]);
    this.executors = new Map<NativeDex, NativeDexExecutor>([
      ['PUMPSWAP', executorOverrides.PUMPSWAP ?? new NotImplementedNativeExecutor('PUMPSWAP')],
      ['RAYDIUM', executorOverrides.RAYDIUM ?? new NotImplementedNativeExecutor('RAYDIUM')],
      ['ORCA', executorOverrides.ORCA ?? new NotImplementedNativeExecutor('ORCA')],
      ['METEORA', executorOverrides.METEORA ?? new NotImplementedNativeExecutor('METEORA')],
    ]);
  }

  /**
   * `onRawActivity`, if given, is called with the DEX label on every raw log
   * delivery from that DEX's existing subscription (see DexMonitor.start's
   * doc comment) — 2026-07-15 Helius credit audit: lets a caller feed
   * source-health liveness tracking off this one subscription instead of
   * opening a second, redundant one per DEX just to get the same signal.
   */
  startAll(
    onLaunch: Parameters<DexMonitor['start']>[0],
    onRawActivity?: (dex: NativeDex) => void,
  ): void {
    for (const [dex, monitor] of this.monitors) {
      if (onRawActivity) {
        monitor.start(onLaunch, () => onRawActivity(dex));
      } else {
        monitor.start(onLaunch);
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.monitors.values()].map((m) => m.stop()));
  }

  async getLiquidity(dex: Dex, poolAddress: string): Promise<DexPoolInfo | undefined> {
    const reader = this.liquidityReaders.get(dex as NativeDex);
    if (!reader) return undefined;
    return reader(this.connection, this.dexScreener, this.solPriceOracle, poolAddress);
  }

  /**
   * The pool's own token-vault accounts — each DEX's pool-state decoder already
   * reads these (to compute reserves), just not exposed until now. Used to
   * exclude the pool itself from holder-concentration counts (see
   * detection/onchain.ts's getHolderConcentration): the vault is usually one of
   * the largest holders by construction, which previously inflated "top 10
   * holder %" for any token with real on-chain liquidity.
   */
  async getVaultAddresses(dex: Dex, poolAddress: string): Promise<string[]> {
    try {
      switch (dex as NativeDex) {
        case 'PUMPSWAP': {
          const state = await getPumpSwapPoolState(this.connection, poolAddress);
          return state ? [state.poolBaseTokenAccount, state.poolQuoteTokenAccount] : [];
        }
        case 'RAYDIUM': {
          const state = await getRaydiumCpmmPoolState(this.connection, poolAddress);
          return state ? [state.token0Vault, state.token1Vault] : [];
        }
        case 'ORCA': {
          const state = await getOrcaWhirlpoolState(this.connection, poolAddress);
          return state ? [state.tokenVaultA, state.tokenVaultB] : [];
        }
        case 'METEORA': {
          const state = await getMeteoraDlmmPoolState(this.connection, poolAddress);
          return state ? [state.reserveX, state.reserveY] : [];
        }
        default:
          return [];
      }
    } catch {
      return [];
    }
  }

  getExecutor(dex: Dex): NativeDexExecutor | undefined {
    return this.executors.get(dex as NativeDex);
  }

  /**
   * Finds the pool a launch event's transaction just created, by checking each of
   * the transaction's non-signer account keys for one now owned by the target
   * DEX's program and decodable as that DEX's pool struct — rather than parsing
   * the specific creation instruction's account ordering (which, unlike the
   * pool-decode logic itself, was never observed against a live example to
   * verify). Reuses the same decoders already verified against real accounts, so
   * a false match (wrong owner, or too-short data) is rejected by the decoder
   * itself, not silently accepted.
   */
  async resolveNewPool(
    dex: NativeDex,
    tx: ParsedTransactionWithMeta,
  ): Promise<DexPoolInfo | undefined> {
    const programId = PROGRAM_ID_BY_DEX[dex];
    const reader = this.liquidityReaders.get(dex);
    if (!reader) return undefined;

    const candidates = tx.transaction.message.accountKeys.filter(
      (k) => k.writable && !k.signer && !NEVER_A_POOL_ACCOUNT.has(k.pubkey.toBase58()),
    );
    if (candidates.length === 0) return undefined;

    // One getMultipleAccountsInfo round trip for every candidate account key in
    // the transaction, instead of one getAccountInfo round trip per candidate —
    // a bundled/Jito-routed launch tx can carry dozens of account keys, all
    // previously fetched serially just to find the one owned by this DEX's program.
    const infos = await this.connection
      .getMultipleAccountsInfo(candidates.map((c) => c.pubkey))
      .catch(() => []);

    for (let i = 0; i < candidates.length; i++) {
      const info = infos[i];
      if (!info || !info.owner.equals(programId)) continue;
      const address = candidates[i]!.pubkey.toBase58();
      const pool = await reader(
        this.connection,
        this.dexScreener,
        this.solPriceOracle,
        address,
      ).catch(() => undefined);
      if (pool) return pool;
    }
    return undefined;
  }
}
