import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from '@nova/shared';
import { SolPriceOracle } from '../pumpfunBondingCurve.js';
import type { DexScreenerClient } from '../dexscreener.js';
import type { DexLaunchHandler, DexMonitor, DexPoolInfo } from './types.js';

export const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

/**
 * Pool account layout, verified live against a real currently-trading pool
 * (CcYbXbMHr2o9Vyz2wmJcRvi59wh42xkXf6qrzChbHPN5) this session: decoded
 * `base_mint`/`quote_mint` matched the known real mints exactly, and the two
 * token-vault balances read from `pool_base_token_account`/`pool_quote_token_account`
 * closely tracked DexScreener's own reported reserves for the same pair (small delta
 * fully explained by trades between the two snapshots).
 */
const OFFSET = {
  poolBump: 8,
  index: 9,
  creator: 11,
  baseMint: 43,
  quoteMint: 75,
  lpMint: 107,
  poolBaseTokenAccount: 139,
  poolQuoteTokenAccount: 171,
  lpSupply: 203,
  // Confirmed against the official pump-fun/pump-public-docs IDL's `Pool` struct
  // field order (coin_creator immediately follows lp_supply). Offset arithmetic is
  // consistent with every field before it, each of which was independently
  // cross-checked against real balances/mints — coin_creator's own *value* wasn't
  // independently cross-checked (no second public source exposes it), only its
  // position in the byte layout.
  coinCreator: 211,
  // is_mayhem_mode immediately follows coin_creator per the IDL. Verified live: a
  // real pool (4bBe7N8WTABTr4AQFkKiM9ST54g8Z9Kb8qy2HTrWGzhn) that failed native
  // PumpSwap buys with `InvalidProtocolFeeRecipient` (6013) has this byte set to 1
  // — the pool requires a *reserved* fee recipient, not a normal one, and the swap
  // executor was picking from the wrong (normal) list.
  isMayhemMode: 243,
};
const MIN_ACCOUNT_LEN = OFFSET.isMayhemMode + 1;

export interface PumpSwapPoolState {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  poolBaseTokenAccount: string;
  poolQuoteTokenAccount: string;
  lpSupply: bigint;
  coinCreator: string;
  isMayhemMode: boolean;
}

export function decodePumpSwapPool(poolAddress: string, data: Buffer): PumpSwapPoolState {
  if (data.length < MIN_ACCOUNT_LEN) {
    throw new Error(`PumpSwap pool account data too short: ${data.length} bytes`);
  }
  const readPubkey = (offset: number) =>
    new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  return {
    poolAddress,
    baseMint: readPubkey(OFFSET.baseMint),
    quoteMint: readPubkey(OFFSET.quoteMint),
    poolBaseTokenAccount: readPubkey(OFFSET.poolBaseTokenAccount),
    poolQuoteTokenAccount: readPubkey(OFFSET.poolQuoteTokenAccount),
    lpSupply: data.readBigUInt64LE(OFFSET.lpSupply),
    coinCreator: readPubkey(OFFSET.coinCreator),
    isMayhemMode: data.readUInt8(OFFSET.isMayhemMode) === 1,
  };
}

export async function getPumpSwapPoolState(
  connection: Connection,
  poolAddress: string,
): Promise<PumpSwapPoolState | undefined> {
  const info = await connection.getAccountInfo(new PublicKey(poolAddress));
  if (!info || !info.owner.equals(PUMPSWAP_PROGRAM_ID)) return undefined;
  return decodePumpSwapPool(poolAddress, info.data);
}

/**
 * Reads the pool's real vault balances (never trusts a stored/cached reserve
 * number) and prices liquidity the same way as the pump.fun bonding-curve reader:
 * quote-side USD value doubled to represent both sides of the pool — verified live
 * against DexScreener's own liquidity.usd for the same real pair (within the delta
 * explained by intervening trades).
 */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Pure so it's independently unit-testable. quoteMint is virtually always SOL for
 * PumpSwap pools (pump.fun migrations always pair against SOL); if it ever isn't,
 * we can't price it without another source, so liquidityUsd is 0 rather than
 * guessed. Doubled quote-side value matches the same convention used by the
 * pump.fun bonding-curve reader and DexScreener's own reported numbers (verified
 * live: within the delta explained by intervening trades for a real pool).
 */
export function calculatePumpSwapLiquidityUsd(
  quoteMint: string,
  quoteReserve: number,
  solPriceUsd: number | undefined,
): number {
  const isQuoteSol = quoteMint === WSOL_MINT;
  return isQuoteSol && solPriceUsd !== undefined ? quoteReserve * solPriceUsd * 2 : 0;
}

export async function getPumpSwapLiquidity(
  connection: Connection,
  dexScreener: DexScreenerClient,
  solPriceOracle: SolPriceOracle,
  poolAddress: string,
): Promise<DexPoolInfo | undefined> {
  const state = await getPumpSwapPoolState(connection, poolAddress);
  if (!state) return undefined;

  const [baseBal, quoteBal, solPriceUsd] = await Promise.all([
    connection.getTokenAccountBalance(new PublicKey(state.poolBaseTokenAccount)),
    connection.getTokenAccountBalance(new PublicKey(state.poolQuoteTokenAccount)),
    solPriceOracle.getPriceUsd(dexScreener),
  ]);

  const baseReserve = baseBal.value.uiAmount ?? 0;
  const quoteReserve = quoteBal.value.uiAmount ?? 0;
  const liquidityUsd = calculatePumpSwapLiquidityUsd(state.quoteMint, quoteReserve, solPriceUsd);

  return {
    dex: 'PUMPSWAP',
    poolAddress,
    baseMint: state.baseMint,
    quoteMint: state.quoteMint,
    baseReserve,
    quoteReserve,
    liquidityUsd,
  };
}

// Pool-creation instructions are rare relative to Buy/Sell/Swap traffic (none
// appeared in a live sample of 60 recent PumpSwap transactions this session,
// unlike Buy/Sell/Swap2 which were common) — this pattern is a best-effort match on
// the Anchor-typical naming convention for AMM pool initialization, not verified
// against a live example the way the pool decode above was. Flagged explicitly
// rather than presented as equally certain.
const POOL_CREATE_RE = /Instruction:\s*(CreatePool|Deposit|InitializePool)$/;

export function isPumpSwapPoolCreation(logs: string[]): boolean {
  return logs.some((l) => POOL_CREATE_RE.test(l));
}

export class PumpSwapMonitor implements DexMonitor {
  private subscriptionId: number | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly logger: Logger,
  ) {}

  start(onEvent: DexLaunchHandler): void {
    if (this.subscriptionId !== undefined) return;
    this.subscriptionId = this.connection.onLogs(
      PUMPSWAP_PROGRAM_ID,
      (logInfo, ctx) => {
        if (logInfo.err) return;
        if (!isPumpSwapPoolCreation(logInfo.logs)) return;
        void onEvent({
          dex: 'PUMPSWAP',
          signature: logInfo.signature,
          slot: ctx.slot,
          detectedAt: new Date().toISOString(),
        });
      },
      'processed',
    );
    this.logger.info({ programId: PUMPSWAP_PROGRAM_ID.toBase58() }, 'PumpSwap monitor started');
  }

  async stop(): Promise<void> {
    if (this.subscriptionId === undefined) return;
    await this.connection.removeOnLogsListener(this.subscriptionId);
    this.subscriptionId = undefined;
  }
}
