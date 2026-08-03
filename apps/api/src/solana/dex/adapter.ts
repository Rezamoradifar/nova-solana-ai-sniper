import type { Transaction, VersionedTransaction, Connection } from '@solana/web3.js';
import type { SolPriceOracle } from '../pumpfunBondingCurve.js';
import type { DexScreenerClient, DexScreenerPair } from '../dexscreener.js';
import {
  NotImplementedNativeExecutor,
  type DexPoolInfo,
  type NativeDexExecutor,
  type NativeDexName,
  type NativeSwapParams,
} from './types.js';

/**
 * DexAdapter (2026-07-29) — a formal, DEX-agnostic interface unifying the
 * pieces DexRegistry (registry.ts) already provides per-DEX (liquidity
 * reading, swap execution) plus two new read-only signals (volume,
 * order-flow) that previously only existed as ad-hoc DexScreener calls
 * scattered across callers. This is a thin composition layer, not new
 * business logic — every concrete adapter delegates to the same
 * already-tested, already-live-verified functions DexRegistry has always
 * used (per-DEX liquidity readers in pumpswap.ts/raydium.ts/orca.ts/
 * meteora.ts, and each DEX's NativeDexExecutor for swap building). See
 * registry.ts's own doc comment for the full per-DEX status table (real vs.
 * stubbed vs. detection-only).
 *
 * Deliberately does NOT replace NativeDexExecutor/DexRegistry.getExecutor —
 * positionManager.ts's sendSwap keeps using those directly (see its own
 * 2026-07-26 bug-fix comment on why the `instanceof NotImplementedNativeExecutor`
 * check there is load-bearing); this interface is additive, for new/analytics
 * callers (see priceMonitor.ts's routing use in a later phase) that want a
 * single per-DEX surface without needing to know DexRegistry's internal map
 * structure.
 */

export interface LiquidityData {
  liquidityUsd: number;
  baseReserve: number;
  quoteReserve: number;
}

export interface VolumeData {
  volumeUsd5m: number;
  volumeUsd1h: number;
  volumeUsd24h: number;
}

export interface OrderFlowData {
  buys5m: number;
  sells5m: number;
  buys1h: number;
  sells1h: number;
}

export interface SwapResult {
  transaction: Transaction | VersionedTransaction;
}

export interface DexAdapter {
  readonly dex: NativeDexName;
  getLiquidity(poolAddress: string): Promise<LiquidityData | undefined>;
  getVolume(mint: string): Promise<VolumeData | undefined>;
  getOrderFlow(mint: string): Promise<OrderFlowData | undefined>;
  /** True once this adapter's underlying executor is a real implementation,
   * not the NotImplementedNativeExecutor stub — lets a caller (e.g. a future
   * execution router) check executability without triggering the stub's
   * "fails loudly" rejection just to find out. */
  readonly isExecutable: boolean;
  executeSwap(params: NativeSwapParams): Promise<SwapResult>;
}

export type LiquidityReader = (
  connection: Connection,
  dexScreener: DexScreenerClient,
  solPriceOracle: SolPriceOracle,
  poolAddress: string,
) => Promise<DexPoolInfo | undefined>;

/**
 * Small, local dexId matcher scoped to just the 4 NativeDexName venues this
 * layer knows about — deliberately NOT importing riskAnalyzer.ts's own
 * mapDexScreenerIdToDex (which covers a superset, including PUMPFUN/JUPITER)
 * to avoid a backwards dependency: apps/api/src/detection already imports
 * FROM apps/api/src/solana/dex, so this file importing back from
 * detection/riskAnalyzer.ts would invert that layering (and risk a circular
 * import via registry.ts). Same lowercase+includes matching convention.
 */
function matchesNativeDex(dexId: string | undefined, dex: NativeDexName): boolean {
  if (!dexId) return false;
  const id = dexId.toLowerCase();
  switch (dex) {
    case 'PUMPSWAP':
      return id.includes('pumpswap');
    case 'RAYDIUM':
      return id.includes('raydium');
    case 'ORCA':
      return id.includes('orca');
    case 'METEORA':
      return id.includes('meteora');
  }
}

/**
 * The one concrete DexAdapter implementation, parametrized per DEX rather
 * than one hand-written class per venue (PumpSwapAdapter/RaydiumAdapter/etc
 * would be identical except for which liquidity reader/executor they close
 * over) — DexRegistry constructs one instance of this per NativeDexName.
 */
export class NativeDexAdapter implements DexAdapter {
  constructor(
    readonly dex: NativeDexName,
    private readonly connection: Connection,
    private readonly dexScreener: DexScreenerClient,
    private readonly solPriceOracle: SolPriceOracle,
    private readonly liquidityReader: LiquidityReader,
    private readonly executor: NativeDexExecutor,
  ) {}

  get isExecutable(): boolean {
    return !(this.executor instanceof NotImplementedNativeExecutor);
  }

  async getLiquidity(poolAddress: string): Promise<LiquidityData | undefined> {
    const pool = await this.liquidityReader(
      this.connection,
      this.dexScreener,
      this.solPriceOracle,
      poolAddress,
    );
    if (!pool) return undefined;
    return {
      liquidityUsd: pool.liquidityUsd,
      baseReserve: pool.baseReserve,
      quoteReserve: pool.quoteReserve,
    };
  }

  /** Finds this mint's DexScreener pair specifically ON this adapter's DEX
   * (not just "the best pair overall," which may be a different venue) —
   * the deepest-liquidity match if more than one pool for this mint trades
   * on the same DEX. */
  private async findOwnPair(mint: string): Promise<DexScreenerPair | undefined> {
    const pairs = await this.dexScreener.getPairsForToken(mint);
    return pairs
      .filter((p) => p.chainId === 'solana' && matchesNativeDex(p.dexId, this.dex))
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  }

  async getVolume(mint: string): Promise<VolumeData | undefined> {
    const pair = await this.findOwnPair(mint);
    if (!pair) return undefined;
    return {
      volumeUsd5m: pair.volume?.m5 ?? 0,
      volumeUsd1h: pair.volume?.h1 ?? 0,
      volumeUsd24h: pair.volume?.h24 ?? 0,
    };
  }

  async getOrderFlow(mint: string): Promise<OrderFlowData | undefined> {
    const pair = await this.findOwnPair(mint);
    if (!pair) return undefined;
    return {
      buys5m: pair.txns?.m5?.buys ?? 0,
      sells5m: pair.txns?.m5?.sells ?? 0,
      buys1h: pair.txns?.h1?.buys ?? 0,
      sells1h: pair.txns?.h1?.sells ?? 0,
    };
  }

  async executeSwap(params: NativeSwapParams): Promise<SwapResult> {
    const transaction = await this.executor.buildSwap(params);
    return { transaction };
  }
}
