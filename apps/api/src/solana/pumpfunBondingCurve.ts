import { Connection, PublicKey } from '@solana/web3.js';
import { PUMPFUN_PROGRAM_ID } from './pumpfun.js';
import type { DexScreenerClient } from './dexscreener.js';
import { SOL_MINT } from './jupiter.js';

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  /** True once the curve has migrated off pump.fun into a real AMM pool. */
  complete: boolean;
}

// 8-byte anchor account discriminator, then five little-endian u64 fields, then a bool.
// Verified by decoding live mainnet bonding-curve accounts and cross-checking
// `realSolReserves` against the account's own raw lamport balance (they match to
// within a small fixed rent-exempt-reserve delta).
const DISCRIMINATOR_BYTES = 8;
const MIN_ACCOUNT_LEN = DISCRIMINATOR_BYTES + 8 * 5 + 1;

export function getBondingCurvePda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  );
  return pda;
}

export function decodeBondingCurveAccount(data: Buffer): BondingCurveState {
  if (data.length < MIN_ACCOUNT_LEN) {
    throw new Error(`bonding curve account data too short: ${data.length} bytes`);
  }
  let offset = DISCRIMINATOR_BYTES;
  const readU64 = () => {
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return v;
  };
  const virtualTokenReserves = readU64();
  const virtualSolReserves = readU64();
  const realTokenReserves = readU64();
  const realSolReserves = readU64();
  const tokenTotalSupply = readU64();
  const complete = data.readUInt8(offset) === 1;
  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
  };
}

/** Fetches and decodes a mint's pump.fun bonding-curve account, or undefined if it doesn't exist / isn't parseable. */
export async function getBondingCurveState(
  connection: Connection,
  mint: string,
): Promise<BondingCurveState | undefined> {
  const pda = getBondingCurvePda(new PublicKey(mint));
  const info = await connection.getAccountInfo(pda);
  if (!info) return undefined;
  return decodeBondingCurveAccount(info.data);
}

// Solana's getMultipleAccountsInfo caps out at 100 accounts per call.
const MAX_ACCOUNTS_PER_BATCH = 100;

/**
 * Batched form of getBondingCurveState for many mints at once — one
 * getMultipleAccountsInfo round trip per 100 mints instead of one
 * getAccountInfo round trip per mint. Exists because MigrationMonitor.tick()
 * previously polled every recently-seen pump.fun token's bonding curve
 * individually and sequentially: with thousands of tokens tracked at once (live
 * production count: 4000+), that was thousands of serial RPC calls every tick —
 * the single largest contributor to sustained Helius rate-limit saturation
 * observed live. Returns a Map so callers can look up by mint; a mint missing
 * from the result (account not found / undecodable) is simply absent, matching
 * getBondingCurveState's `undefined` return for the same cases.
 */
export async function getBondingCurveStates(
  connection: Connection,
  mints: string[],
): Promise<Map<string, BondingCurveState>> {
  const result = new Map<string, BondingCurveState>();
  if (mints.length === 0) return result;

  const pdas = mints.map((mint) => getBondingCurvePda(new PublicKey(mint)));

  for (let i = 0; i < pdas.length; i += MAX_ACCOUNTS_PER_BATCH) {
    const batchMints = mints.slice(i, i + MAX_ACCOUNTS_PER_BATCH);
    const batchPdas = pdas.slice(i, i + MAX_ACCOUNTS_PER_BATCH);
    const infos = await connection.getMultipleAccountsInfo(batchPdas);
    infos.forEach((info, idx) => {
      if (!info) return;
      try {
        result.set(batchMints[idx]!, decodeBondingCurveAccount(info.data));
      } catch {
        // Not a decodable bonding-curve account — same as getBondingCurveState
        // treating it as absent rather than throwing and aborting the batch.
      }
    });
  }

  return result;
}

/**
 * Estimates the USD liquidity backing a pre-migration bonding curve from its real
 * (non-virtual) SOL reserves. Doubled to match the convention DexScreener/AMM UIs use
 * for pool liquidity (both sides of a balanced pool are worth the same amount, so total
 * pool value ~= 2x one side) — this keeps the number comparable to the post-migration
 * DexScreener figure the same token will report once it graduates to a real AMM pool.
 * Returns undefined once the curve is `complete` (migrated): its real reserves have been
 * withdrawn as part of migration and no longer reflect current liquidity.
 */
export function estimateBondingCurveLiquidityUsd(
  state: BondingCurveState,
  solPriceUsd: number,
): number | undefined {
  if (state.complete) return undefined;
  const realSol = Number(state.realSolReserves) / 1e9;
  return realSol * solPriceUsd * 2;
}

const SOL_PRICE_CACHE_MS = 30_000;

/**
 * SOL/USD price via the deepest SOL/USDC-or-similar pair DexScreener knows about,
 * cached briefly so a burst of detections doesn't hammer DexScreener with a
 * redundant SOL-price lookup per token. An instance (not a module-level global)
 * so it can be constructed fresh per test/worker instead of leaking state.
 */
export class SolPriceOracle {
  private cached: { value: number; fetchedAt: number } | undefined;

  async getPriceUsd(dexScreener: DexScreenerClient): Promise<number | undefined> {
    if (this.cached && Date.now() - this.cached.fetchedAt < SOL_PRICE_CACHE_MS) {
      return this.cached.value;
    }
    const pair = await dexScreener.getBestSolanaPair(SOL_MINT);
    const price = pair?.priceUsd ? Number(pair.priceUsd) : undefined;
    if (price !== undefined && Number.isFinite(price)) {
      this.cached = { value: price, fetchedAt: Date.now() };
      return price;
    }
    return undefined;
  }
}
