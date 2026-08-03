import type { Connection, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';

export type NativeDexName = 'PUMPSWAP' | 'RAYDIUM' | 'ORCA' | 'METEORA';

/** A liquidity pool read from on-chain, native to one DEX. */
export interface DexPoolInfo {
  dex: NativeDexName;
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  /** UI (decimal-adjusted) reserve amounts, read directly from the pool's token vaults. */
  baseReserve: number;
  quoteReserve: number;
  liquidityUsd: number;
}

/** A newly-observed pool-creation event from a DEX's onLogs subscription. */
export interface DexLaunchEvent {
  dex: NativeDexName;
  signature: string;
  slot: number;
  detectedAt: string;
}

export type DexLaunchHandler = (event: DexLaunchEvent) => void | Promise<void>;

/** Same shape as PumpFunMonitor/PriceMonitor's start/stop lifecycle, one per DEX. */
export interface DexMonitor {
  /**
   * `onRawActivity`, if given, fires on every raw log delivery for this
   * program — before the `logInfo.err` check and before the pool-creation
   * filter, i.e. far more often than `onEvent` (which only fires on a
   * confirmed pool creation). 2026-07-15 Helius credit audit: this exists so
   * a caller that needs a true "is this WS subscription still alive" signal
   * (see sourceHealthMonitor.ts — pool creations are too rare on their own to
   * safely gate liveness on) can get it from THIS subscription instead of
   * opening a second, fully redundant `onLogs` subscription to the same
   * program purely for that purpose.
   */
  start(onEvent: DexLaunchHandler, onRawActivity?: () => void): void;
  stop(): Promise<void> | void;
}

export interface NativeSwapParams {
  connection: Connection;
  signer: Keypair;
  inputMint: string;
  outputMint: string;
  amountLamports: bigint;
  slippageBps: number;
  /** Known pool address for the token, if already on file (e.g. from DexScreener/migration detection) — avoids re-discovering it. */
  poolAddress?: string;
}

/**
 * A DEX-specific swap builder used only as a fallback when Jupiter can't route a
 * trade. Every implementation must simulate (never assume) before a transaction is
 * considered sendable — same discipline Jupiter's own path already follows.
 */
export interface NativeDexExecutor {
  readonly dex: string;
  buildSwap(params: NativeSwapParams): Promise<Transaction | VersionedTransaction>;
}

export class NotImplementedNativeExecutor implements NativeDexExecutor {
  constructor(public readonly dex: string) {}

  buildSwap(): Promise<Transaction | VersionedTransaction> {
    return Promise.reject(
      new Error(
        `No native ${this.dex} executor is implemented yet — Jupiter is the only execution path for this DEX. Fails loudly rather than silently no-opping.`,
      ),
    );
  }
}
