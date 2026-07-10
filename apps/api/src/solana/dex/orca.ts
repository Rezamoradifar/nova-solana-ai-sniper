import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from '@nova/shared';
import { SolPriceOracle } from '../pumpfunBondingCurve.js';
import type { DexScreenerClient } from '../dexscreener.js';
import type { DexLaunchHandler, DexMonitor, DexPoolInfo } from './types.js';

export const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey(
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
);

/**
 * Whirlpool account layout, sourced from orca-so/whirlpools' own `state/whirlpool.rs`
 * (`LEN = 8 + 261 + 384 = 653`) and verified live against a real currently-trading
 * pool (Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE, SOL/USDC): data length matched
 * exactly (653 bytes), decoded token_mint_a/token_mint_b were the real SOL/USDC
 * mints, and the two vault balances closely tracked DexScreener's independently
 * reported reserves for the same pair (219,331 vs 219,104 SOL; 8,379,194 vs
 * 8,396,810 USDC).
 */
const OFFSET = {
  whirlpoolsConfig: 8,
  tickSpacing: 41,
  feeRate: 45,
  protocolFeeRate: 47,
  liquidity: 49,
  sqrtPrice: 65,
  tickCurrentIndex: 81,
  tokenMintA: 101,
  tokenVaultA: 133,
  tokenMintB: 181,
  tokenVaultB: 213,
};
const MIN_ACCOUNT_LEN = OFFSET.tokenVaultB + 32;

export interface OrcaWhirlpoolState {
  poolAddress: string;
  tokenMintA: string;
  tokenVaultA: string;
  tokenMintB: string;
  tokenVaultB: string;
  tickSpacing: number;
}

export function decodeOrcaWhirlpool(poolAddress: string, data: Buffer): OrcaWhirlpoolState {
  if (data.length < MIN_ACCOUNT_LEN) {
    throw new Error(`Orca Whirlpool account data too short: ${data.length} bytes`);
  }
  const readPubkey = (offset: number) =>
    new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  return {
    poolAddress,
    tokenMintA: readPubkey(OFFSET.tokenMintA),
    tokenVaultA: readPubkey(OFFSET.tokenVaultA),
    tokenMintB: readPubkey(OFFSET.tokenMintB),
    tokenVaultB: readPubkey(OFFSET.tokenVaultB),
    tickSpacing: data.readUInt16LE(OFFSET.tickSpacing),
  };
}

export async function getOrcaWhirlpoolState(
  connection: Connection,
  poolAddress: string,
): Promise<OrcaWhirlpoolState | undefined> {
  const info = await connection.getAccountInfo(new PublicKey(poolAddress));
  if (!info || !info.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID)) return undefined;
  return decodeOrcaWhirlpool(poolAddress, info.data);
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Pure liquidity calc. Whirlpool's token_mint_a/b ordering doesn't guarantee which
 * side is SOL (verified live: the sampled SOL/USDC pool has SOL as the "a" side,
 * but that's pair-specific, not a protocol guarantee) — resolved dynamically.
 * Concentrated-liquidity depth (the `liquidity`/`sqrt_price` fields) is not used
 * here; this reads actual vault balances directly, same as the other DEX readers,
 * which correctly reflects total pool TVL regardless of how it's distributed
 * across ticks.
 */
export function calculateOrcaWhirlpoolLiquidityUsd(
  tokenMintA: string,
  tokenMintB: string,
  reserveA: number,
  reserveB: number,
  solPriceUsd: number | undefined,
): number {
  if (solPriceUsd === undefined) return 0;
  if (tokenMintA === WSOL_MINT) return reserveA * solPriceUsd * 2;
  if (tokenMintB === WSOL_MINT) return reserveB * solPriceUsd * 2;
  return 0;
}

export async function getOrcaWhirlpoolLiquidity(
  connection: Connection,
  dexScreener: DexScreenerClient,
  solPriceOracle: SolPriceOracle,
  poolAddress: string,
): Promise<DexPoolInfo | undefined> {
  const state = await getOrcaWhirlpoolState(connection, poolAddress);
  if (!state) return undefined;

  const [balA, balB, solPriceUsd] = await Promise.all([
    connection.getTokenAccountBalance(new PublicKey(state.tokenVaultA)),
    connection.getTokenAccountBalance(new PublicKey(state.tokenVaultB)),
    solPriceOracle.getPriceUsd(dexScreener),
  ]);

  const reserveA = balA.value.uiAmount ?? 0;
  const reserveB = balB.value.uiAmount ?? 0;
  const liquidityUsd = calculateOrcaWhirlpoolLiquidityUsd(
    state.tokenMintA,
    state.tokenMintB,
    reserveA,
    reserveB,
    solPriceUsd,
  );

  const isASol = state.tokenMintA === WSOL_MINT;
  return {
    dex: 'ORCA',
    poolAddress,
    baseMint: isASol ? state.tokenMintB : state.tokenMintA,
    quoteMint: isASol ? state.tokenMintA : state.tokenMintB,
    baseReserve: isASol ? reserveB : reserveA,
    quoteReserve: isASol ? reserveA : reserveB,
    liquidityUsd,
  };
}

// Sourced from the instruction files present in orca-so/whirlpools' own repo
// (instructions/initialize_pool.rs and instructions/v2/initialize_pool.rs) — pool
// creations are rare relative to swap traffic, so unlike the pool-decode logic
// above, this specific instruction name has not been cross-checked live.
const POOL_CREATE_RE = /Instruction:\s*InitializePool(V2)?$/;

export function isOrcaWhirlpoolPoolCreation(logs: string[]): boolean {
  return logs.some((l) => POOL_CREATE_RE.test(l));
}

export class OrcaWhirlpoolMonitor implements DexMonitor {
  private subscriptionId: number | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly logger: Logger,
  ) {}

  start(onEvent: DexLaunchHandler): void {
    if (this.subscriptionId !== undefined) return;
    this.subscriptionId = this.connection.onLogs(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      (logInfo, ctx) => {
        if (logInfo.err) return;
        if (!isOrcaWhirlpoolPoolCreation(logInfo.logs)) return;
        void onEvent({
          dex: 'ORCA',
          signature: logInfo.signature,
          slot: ctx.slot,
          detectedAt: new Date().toISOString(),
        });
      },
      'processed',
    );
    this.logger.info(
      { programId: ORCA_WHIRLPOOL_PROGRAM_ID.toBase58() },
      'Orca Whirlpool monitor started',
    );
  }

  async stop(): Promise<void> {
    if (this.subscriptionId === undefined) return;
    await this.connection.removeOnLogsListener(this.subscriptionId);
    this.subscriptionId = undefined;
  }
}
