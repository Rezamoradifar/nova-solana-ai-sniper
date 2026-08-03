import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from '@nova/shared';
import { SolPriceOracle } from '../pumpfunBondingCurve.js';
import type { DexScreenerClient } from '../dexscreener.js';
import type { DexLaunchHandler, DexMonitor, DexPoolInfo } from './types.js';

/**
 * The dlmm-sdk repo's `Anchor.toml` lists `LbVRzDTvBDEcrthxfZ4RL6yiq3uZw8bS6MwtdY6UhFQ`
 * under `[[test.genesis]]` — that's a *localnet test* program id, not the real
 * mainnet deployment. Verified live against a real currently-trading pool
 * (6oFWm7KPLfxnwMb3z5xwBoXNSPP3JJyirAPqPSiVcnsp, BONK/SOL): the account's actual
 * owner on mainnet is the address below.
 */
export const METEORA_DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

/**
 * LbPair account layout, computed from Meteora's own published IDL
 * (idls/dlmm.json: LbPair -> StaticParameters (32 bytes) + VariableParameters
 * (32 bytes) + fixed fields) and verified live against a real pool: decoded
 * token_x_mint/token_y_mint were the real BONK/SOL mints, and reserve_x/reserve_y
 * vault balances matched DexScreener's independently reported reserves almost
 * exactly (53,862,110,825.84 vs 53,862,110,825 BONK; 64.2607 vs 64.2606 SOL).
 *
 * Only the basic vault-balance TVL reading is implemented here — DLMM's bin-level
 * liquidity distribution (how much sits within active-price range vs. far bins,
 * needed for real slippage-depth estimates rather than a flat TVL number) is
 * explicitly deferred, per the plan's flagged scope.
 */
const OFFSET = {
  activeId: 76,
  binStep: 80,
  status: 82,
  tokenXMint: 88,
  tokenYMint: 120,
  reserveX: 152,
  reserveY: 184,
};
const MIN_ACCOUNT_LEN = OFFSET.reserveY + 32;

export interface MeteoraDlmmPoolState {
  poolAddress: string;
  tokenXMint: string;
  tokenYMint: string;
  reserveX: string;
  reserveY: string;
  binStep: number;
  activeId: number;
}

export function decodeMeteoraDlmmPool(poolAddress: string, data: Buffer): MeteoraDlmmPoolState {
  if (data.length < MIN_ACCOUNT_LEN) {
    throw new Error(`Meteora DLMM pool account data too short: ${data.length} bytes`);
  }
  const readPubkey = (offset: number) =>
    new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  return {
    poolAddress,
    tokenXMint: readPubkey(OFFSET.tokenXMint),
    tokenYMint: readPubkey(OFFSET.tokenYMint),
    reserveX: readPubkey(OFFSET.reserveX),
    reserveY: readPubkey(OFFSET.reserveY),
    binStep: data.readUInt16LE(OFFSET.binStep),
    activeId: data.readInt32LE(OFFSET.activeId),
  };
}

export async function getMeteoraDlmmPoolState(
  connection: Connection,
  poolAddress: string,
): Promise<MeteoraDlmmPoolState | undefined> {
  const info = await connection.getAccountInfo(new PublicKey(poolAddress));
  if (!info || !info.owner.equals(METEORA_DLMM_PROGRAM_ID)) return undefined;
  return decodeMeteoraDlmmPool(poolAddress, info.data);
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Pure liquidity calc — same "flat TVL from vault balances" approach as the other DEX readers. */
export function calculateMeteoraDlmmLiquidityUsd(
  tokenXMint: string,
  tokenYMint: string,
  reserveX: number,
  reserveY: number,
  solPriceUsd: number | undefined,
): number {
  if (solPriceUsd === undefined) return 0;
  if (tokenXMint === WSOL_MINT) return reserveX * solPriceUsd * 2;
  if (tokenYMint === WSOL_MINT) return reserveY * solPriceUsd * 2;
  return 0;
}

export async function getMeteoraDlmmLiquidity(
  connection: Connection,
  dexScreener: DexScreenerClient,
  solPriceOracle: SolPriceOracle,
  poolAddress: string,
): Promise<DexPoolInfo | undefined> {
  const state = await getMeteoraDlmmPoolState(connection, poolAddress);
  if (!state) return undefined;

  const [balX, balY, solPriceUsd] = await Promise.all([
    connection.getTokenAccountBalance(new PublicKey(state.reserveX)),
    connection.getTokenAccountBalance(new PublicKey(state.reserveY)),
    solPriceOracle.getPriceUsd(dexScreener),
  ]);

  const reserveX = balX.value.uiAmount ?? 0;
  const reserveY = balY.value.uiAmount ?? 0;
  const liquidityUsd = calculateMeteoraDlmmLiquidityUsd(
    state.tokenXMint,
    state.tokenYMint,
    reserveX,
    reserveY,
    solPriceUsd,
  );

  const isXSol = state.tokenXMint === WSOL_MINT;
  return {
    dex: 'METEORA',
    poolAddress,
    baseMint: isXSol ? state.tokenYMint : state.tokenXMint,
    quoteMint: isXSol ? state.tokenXMint : state.tokenYMint,
    baseReserve: isXSol ? reserveY : reserveX,
    quoteReserve: isXSol ? reserveX : reserveY,
    liquidityUsd,
  };
}

// Sourced directly from Meteora's own published IDL instruction list
// (initialize_lb_pair / initialize_lb_pair2 / initialize_customizable_permissionless_lb_pair(2) /
// initialize_permission_lb_pair) — pool creations are rare relative to swap
// traffic, so unlike the pool-decode logic above, these instruction names have
// not been cross-checked against a live example.
const POOL_CREATE_RE =
  /Instruction:\s*(InitializeLbPair2?|InitializeCustomizablePermissionlessLbPair2?|InitializePermissionLbPair)$/;

export function isMeteoraDlmmPoolCreation(logs: string[]): boolean {
  return logs.some((l) => POOL_CREATE_RE.test(l));
}

export class MeteoraDlmmMonitor implements DexMonitor {
  private subscriptionId: number | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly logger: Logger,
  ) {}

  start(onEvent: DexLaunchHandler, onRawActivity?: () => void): void {
    if (this.subscriptionId !== undefined) return;
    this.subscriptionId = this.connection.onLogs(
      METEORA_DLMM_PROGRAM_ID,
      (logInfo, ctx) => {
        onRawActivity?.();
        if (logInfo.err) return;
        if (!isMeteoraDlmmPoolCreation(logInfo.logs)) return;
        void onEvent({
          dex: 'METEORA',
          signature: logInfo.signature,
          slot: ctx.slot,
          detectedAt: new Date().toISOString(),
        });
      },
      'processed',
    );
    this.logger.info(
      { programId: METEORA_DLMM_PROGRAM_ID.toBase58() },
      'Meteora DLMM monitor started',
    );
  }

  async stop(): Promise<void> {
    if (this.subscriptionId === undefined) return;
    await this.connection.removeOnLogsListener(this.subscriptionId);
    this.subscriptionId = undefined;
  }
}
