import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from '@nova/shared';
import { SolPriceOracle } from '../pumpfunBondingCurve.js';
import type { DexScreenerClient } from '../dexscreener.js';
import type { DexLaunchHandler, DexMonitor, DexPoolInfo } from './types.js';

/** Raydium's CPMM ("CP-Swap") program — the current recommended pool type, no
 * OpenBook market required. Raydium's older AMM v4 (`675kPX9...`) and CLMM
 * (concentrated liquidity) programs are separate deployments with different
 * account layouts, out of scope for this pass — see the plan's deferred scope. */
export const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey(
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
);

/**
 * PoolState layout, sourced from raydium-cp-swap's own `states/pool.rs`
 * (`#[repr(C, packed)]`, `LEN = 637`) and verified live against a real currently-
 * trading pool (7ZFLTdJCmL8PQozEmfPcq8dxsjR4W7LLkbK8hqSGZnQ1): decoded
 * token_0_mint/token_1_mint were real, and the two vault balances read from
 * token_0_vault/token_1_vault matched DexScreener's independently reported
 * reserves for the same pair almost exactly (95.05 vs 94.96 SOL, 13328.8 vs
 * 13341 base token).
 */
const OFFSET = {
  ammConfig: 8,
  poolCreator: 40,
  token0Vault: 72,
  token1Vault: 104,
  lpMint: 136,
  token0Mint: 168,
  token1Mint: 200,
  token0Program: 232,
  token1Program: 264,
  observationKey: 296,
  authBump: 328,
  status: 329,
  lpMintDecimals: 330,
  mint0Decimals: 331,
  mint1Decimals: 332,
  lpSupply: 333,
};
const MIN_ACCOUNT_LEN = OFFSET.lpSupply + 8;

export interface RaydiumCpmmPoolState {
  poolAddress: string;
  ammConfig: string;
  token0Vault: string;
  token1Vault: string;
  token0Mint: string;
  token1Mint: string;
  /** Each side's real SPL token program (classic Token or Token-2022), read
   * directly from the pool account — unlike PumpSwap, Raydium CPMM pool state
   * already stores this per side, so no extra RPC round-trip is needed to
   * detect a Token-2022 mint (see raydiumExecutor.ts). */
  token0Program: string;
  token1Program: string;
  /** The pool's price-oracle observation account — a required, mutable
   * account on every swap instruction (see raydiumExecutor.ts). */
  observationKey: string;
  status: number;
  lpSupply: bigint;
}

export function decodeRaydiumCpmmPool(poolAddress: string, data: Buffer): RaydiumCpmmPoolState {
  if (data.length < MIN_ACCOUNT_LEN) {
    throw new Error(`Raydium CPMM pool account data too short: ${data.length} bytes`);
  }
  const readPubkey = (offset: number) =>
    new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  return {
    poolAddress,
    ammConfig: readPubkey(OFFSET.ammConfig),
    token0Vault: readPubkey(OFFSET.token0Vault),
    token1Vault: readPubkey(OFFSET.token1Vault),
    token0Mint: readPubkey(OFFSET.token0Mint),
    token1Mint: readPubkey(OFFSET.token1Mint),
    token0Program: readPubkey(OFFSET.token0Program),
    token1Program: readPubkey(OFFSET.token1Program),
    observationKey: readPubkey(OFFSET.observationKey),
    status: data.readUInt8(OFFSET.status),
    lpSupply: data.readBigUInt64LE(OFFSET.lpSupply),
  };
}

export async function getRaydiumCpmmPoolState(
  connection: Connection,
  poolAddress: string,
): Promise<RaydiumCpmmPoolState | undefined> {
  const info = await connection.getAccountInfo(new PublicKey(poolAddress));
  if (!info || !info.owner.equals(RAYDIUM_CPMM_PROGRAM_ID)) return undefined;
  return decodeRaydiumCpmmPool(poolAddress, info.data);
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Pure liquidity calc, unit-testable in isolation. Unlike PumpSwap (base/quote are
 * explicit roles), Raydium CPMM's token_0/token_1 ordering doesn't guarantee which
 * side is SOL, so it's resolved dynamically from whichever mint matches WSOL.
 */
export function calculateRaydiumCpmmLiquidityUsd(
  token0Mint: string,
  token1Mint: string,
  token0Reserve: number,
  token1Reserve: number,
  solPriceUsd: number | undefined,
): number {
  if (solPriceUsd === undefined) return 0;
  if (token0Mint === WSOL_MINT) return token0Reserve * solPriceUsd * 2;
  if (token1Mint === WSOL_MINT) return token1Reserve * solPriceUsd * 2;
  return 0;
}

export async function getRaydiumCpmmLiquidity(
  connection: Connection,
  dexScreener: DexScreenerClient,
  solPriceOracle: SolPriceOracle,
  poolAddress: string,
): Promise<DexPoolInfo | undefined> {
  const state = await getRaydiumCpmmPoolState(connection, poolAddress);
  if (!state) return undefined;

  const [bal0, bal1, solPriceUsd] = await Promise.all([
    connection.getTokenAccountBalance(new PublicKey(state.token0Vault)),
    connection.getTokenAccountBalance(new PublicKey(state.token1Vault)),
    solPriceOracle.getPriceUsd(dexScreener),
  ]);

  const token0Reserve = bal0.value.uiAmount ?? 0;
  const token1Reserve = bal1.value.uiAmount ?? 0;
  const liquidityUsd = calculateRaydiumCpmmLiquidityUsd(
    state.token0Mint,
    state.token1Mint,
    token0Reserve,
    token1Reserve,
    solPriceUsd,
  );

  const isToken0Sol = state.token0Mint === WSOL_MINT;
  return {
    dex: 'RAYDIUM',
    poolAddress,
    baseMint: isToken0Sol ? state.token1Mint : state.token0Mint,
    quoteMint: isToken0Sol ? state.token0Mint : state.token1Mint,
    baseReserve: isToken0Sol ? token1Reserve : token0Reserve,
    quoteReserve: isToken0Sol ? token0Reserve : token1Reserve,
    liquidityUsd,
  };
}

// Sourced from the instruction files present in raydium-cp-swap's own repo
// (initialize.rs / initialize_with_permission.rs) — pool creations are rare
// relative to swap traffic (none appeared in live sampling this session, same as
// PumpSwap's), so unlike the pool-decode logic above, this specific instruction
// name has not been cross-checked against a live example.
const POOL_CREATE_RE = /Instruction:\s*(Initialize|InitializeWithPermission)$/;

export function isRaydiumCpmmPoolCreation(logs: string[]): boolean {
  return logs.some((l) => POOL_CREATE_RE.test(l));
}

export class RaydiumCpmmMonitor implements DexMonitor {
  private subscriptionId: number | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly logger: Logger,
  ) {}

  start(onEvent: DexLaunchHandler, onRawActivity?: () => void): void {
    if (this.subscriptionId !== undefined) return;
    this.subscriptionId = this.connection.onLogs(
      RAYDIUM_CPMM_PROGRAM_ID,
      (logInfo, ctx) => {
        onRawActivity?.();
        if (logInfo.err) return;
        if (!isRaydiumCpmmPoolCreation(logInfo.logs)) return;
        void onEvent({
          dex: 'RAYDIUM',
          signature: logInfo.signature,
          slot: ctx.slot,
          detectedAt: new Date().toISOString(),
        });
      },
      'processed',
    );
    this.logger.info(
      { programId: RAYDIUM_CPMM_PROGRAM_ID.toBase58() },
      'Raydium CPMM monitor started',
    );
  }

  async stop(): Promise<void> {
    if (this.subscriptionId === undefined) return;
    await this.connection.removeOnLogsListener(this.subscriptionId);
    this.subscriptionId = undefined;
  }
}
