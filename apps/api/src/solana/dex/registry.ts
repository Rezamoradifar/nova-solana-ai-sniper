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
import { MonitorWatchdog } from '../monitorWatchdog.js';
import { NativeDexAdapter, type DexAdapter } from './adapter.js';

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
 *
 * Status per DEX (2026-07-29 audit, see apps/api/src/solana/dex/adapter.ts for
 * the formal DexAdapter interface this registry now also exposes):
 *
 * | DEX       | Monitor | Liquidity reader | Swap executor                          |
 * |-----------|---------|-------------------|----------------------------------------|
 * | PUMPSWAP  | real    | real              | real, live-verified (pumpswapExecutor.ts) |
 * | RAYDIUM   | real    | real              | real, NOT live-verified (raydiumExecutor.ts — see its doc comment) |
 * | ORCA      | real    | real              | stub (NotImplementedNativeExecutor — Whirlpool concentrated-liquidity swap not built) |
 * | METEORA   | real    | real              | stub (NotImplementedNativeExecutor — DLMM bin-based swap not built) |
 * | LIFINITY  | none    | none              | none — detection-only (Token.dex labeling via DexScreener dexId, see migrationMonitor.ts/riskAnalyzer.ts) |
 * | FLUXBEAM  | none    | none              | none — detection-only |
 * | OPENBOOK  | none    | none              | none — detection-only |
 * | PHOENIX   | none    | none              | none — detection-only |
 *
 * The last 4 are deliberately NOT registered here (not added to NativeDexName) —
 * this registry's maps assume a working liquidity reader exists for every entry
 * (resolveNewPool, getVaultAddresses); adding a DEX with no reader would silently
 * degrade those call sites rather than fail loudly like NotImplementedNativeExecutor
 * does for swap building.
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
    // Wraps each per-DEX onLogs monitor with a liveness watchdog (see
    // monitorWatchdog.ts) so a silently-dropped websocket force-restarts instead of
    // flatlining detection for that DEX forever. Undefined (the default, used by
    // most tests) leaves monitors unwrapped — the watchdog's own interval timer
    // would otherwise outlive short-lived test instances.
    watchdogIdleMs?: number,
    // Config-driven enable/disable (2026-07-29, ENABLED_NATIVE_DEXES env var —
    // see packages/shared/src/env.ts): a DEX not in this set gets no monitor,
    // no liquidity reader, no executor at all — same end state as if it were
    // never registered here, letting an operator disable a misbehaving DEX
    // integration without a redeploy. Undefined (the default, used by every
    // existing caller/test) enables all 4 — today's exact behavior.
    enabledDexes: ReadonlySet<NativeDex> = new Set(['PUMPSWAP', 'RAYDIUM', 'ORCA', 'METEORA']),
  ) {
    const wrap = (dex: NativeDex, monitor: DexMonitor): DexMonitor =>
      watchdogIdleMs === undefined
        ? monitor
        : new MonitorWatchdog(monitor, logger, { label: dex, idleThresholdMs: watchdogIdleMs });

    const filterEnabled = <T>(entries: [NativeDex, T][]): [NativeDex, T][] =>
      entries.filter(([dex]) => enabledDexes.has(dex));

    this.monitors = new Map<NativeDex, DexMonitor>(
      filterEnabled([
        ['PUMPSWAP', wrap('PUMPSWAP', new PumpSwapMonitor(connection, logger))],
        ['RAYDIUM', wrap('RAYDIUM', new RaydiumCpmmMonitor(connection, logger))],
        ['ORCA', wrap('ORCA', new OrcaWhirlpoolMonitor(connection, logger))],
        ['METEORA', wrap('METEORA', new MeteoraDlmmMonitor(connection, logger))],
      ]),
    );
    this.liquidityReaders = new Map<NativeDex, LiquidityReader>(
      filterEnabled([
        ['PUMPSWAP', getPumpSwapLiquidity],
        ['RAYDIUM', getRaydiumCpmmLiquidity],
        ['ORCA', getOrcaWhirlpoolLiquidity],
        ['METEORA', getMeteoraDlmmLiquidity],
      ]),
    );
    this.executors = new Map<NativeDex, NativeDexExecutor>(
      filterEnabled([
        ['PUMPSWAP', executorOverrides.PUMPSWAP ?? new NotImplementedNativeExecutor('PUMPSWAP')],
        ['RAYDIUM', executorOverrides.RAYDIUM ?? new NotImplementedNativeExecutor('RAYDIUM')],
        ['ORCA', executorOverrides.ORCA ?? new NotImplementedNativeExecutor('ORCA')],
        ['METEORA', executorOverrides.METEORA ?? new NotImplementedNativeExecutor('METEORA')],
      ]),
    );
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
   * The formal DexAdapter surface (see adapter.ts) for one DEX — a thin
   * wrapper composing this registry's own liquidity reader + executor, built
   * fresh per call rather than cached (constructing NativeDexAdapter is
   * allocation-only, no I/O). Additive: existing callers (positionManager.ts's
   * sendSwap) keep using getExecutor/getLiquidity directly and are
   * unaffected — this is for new/analytics callers that want one per-DEX
   * surface instead of composing the registry's individual methods
   * themselves.
   */
  getAdapter(dex: Dex): DexAdapter | undefined {
    const nativeDex = dex as NativeDex;
    const reader = this.liquidityReaders.get(nativeDex);
    const executor = this.executors.get(nativeDex);
    if (!reader || !executor) return undefined;
    return new NativeDexAdapter(
      nativeDex,
      this.connection,
      this.dexScreener,
      this.solPriceOracle,
      reader,
      executor,
    );
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
