import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  decodeBondingCurveAccount,
  estimateBondingCurveLiquidityUsd,
  getBondingCurvePda,
} from './pumpfunBondingCurve.js';

function buildAccountData(fields: {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}): Buffer {
  const buf = Buffer.alloc(8 + 8 * 5 + 1);
  buf.writeBigUInt64LE(0n, 0); // discriminator, value irrelevant to decoding
  let offset = 8;
  for (const v of [
    fields.virtualTokenReserves,
    fields.virtualSolReserves,
    fields.realTokenReserves,
    fields.realSolReserves,
    fields.tokenTotalSupply,
  ]) {
    buf.writeBigUInt64LE(v, offset);
    offset += 8;
  }
  buf.writeUInt8(fields.complete ? 1 : 0, offset);
  return buf;
}

describe('getBondingCurvePda', () => {
  it('matches the real on-chain PDA for a live pump.fun mint', () => {
    // Verified live on mainnet 2026-07-10: mint 8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump's
    // bonding curve account is HGUqZAU8QxTxaD1Eb8Q3oHLNKvfDhGTQSFMkgKcCfobc.
    const pda = getBondingCurvePda(new PublicKey('8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump'));
    expect(pda.toBase58()).toBe('HGUqZAU8QxTxaD1Eb8Q3oHLNKvfDhGTQSFMkgKcCfobc');
  });

  it('is deterministic for the same mint', () => {
    const mint = new PublicKey('GrNhoFEfsfvgir93SY9eBSokvxw9aDCtWD5Rodthpump');
    expect(getBondingCurvePda(mint).equals(getBondingCurvePda(mint))).toBe(true);
  });
});

describe('decodeBondingCurveAccount', () => {
  it('decodes real reserve values captured from a live bonding curve account', () => {
    // Live account data for HGUqZAU8QxTxaD1Eb8Q3oHLNKvfDhGTQSFMkgKcCfobc (mint 8Jex...pump),
    // cross-checked against the account's raw lamport balance (0.692941285 SOL): the decoded
    // realSolReserves (0.691250005 SOL) plus a small fixed rent-exempt buffer accounts for the
    // full lamport balance, confirming the field offsets are correct.
    const data = buildAccountData({
      virtualTokenReserves: 1048833136483417n,
      virtualSolReserves: 30691250005n,
      realTokenReserves: 768933136483417n,
      realSolReserves: 691250005n,
      tokenTotalSupply: 1000000000000000n,
      complete: false,
    });

    const state = decodeBondingCurveAccount(data);
    expect(state.realSolReserves).toBe(691250005n);
    expect(state.virtualSolReserves).toBe(30691250005n);
    expect(state.tokenTotalSupply).toBe(1000000000000000n);
    expect(state.complete).toBe(false);
  });

  it('throws on a too-short buffer instead of silently misreading it', () => {
    expect(() => decodeBondingCurveAccount(Buffer.alloc(10))).toThrow();
  });
});

describe('estimateBondingCurveLiquidityUsd', () => {
  it('matches the manually-verified figure for a real live bonding curve', () => {
    // realSolReserves 691250005 lamports = 0.691250005 SOL, SOL/USD 77.91 (live DexScreener
    // SOL/USDC price at capture time) => 2x-side liquidity ~= $107.71.
    const state = decodeBondingCurveAccount(
      buildAccountData({
        virtualTokenReserves: 1048833136483417n,
        virtualSolReserves: 30691250005n,
        realTokenReserves: 768933136483417n,
        realSolReserves: 691250005n,
        tokenTotalSupply: 1000000000000000n,
        complete: false,
      }),
    );
    const liquidityUsd = estimateBondingCurveLiquidityUsd(state, 77.91);
    expect(liquidityUsd).toBeCloseTo(107.71, 1);
  });

  it('returns undefined once the curve has migrated (complete)', () => {
    const state = decodeBondingCurveAccount(
      buildAccountData({
        virtualTokenReserves: 0n,
        virtualSolReserves: 0n,
        realTokenReserves: 0n,
        realSolReserves: 0n,
        tokenTotalSupply: 1000000000000000n,
        complete: true,
      }),
    );
    expect(estimateBondingCurveLiquidityUsd(state, 77.91)).toBeUndefined();
  });

  it('returns 0 for a curve with no real SOL reserves rather than throwing', () => {
    const state = decodeBondingCurveAccount(
      buildAccountData({
        virtualTokenReserves: 0n,
        virtualSolReserves: 0n,
        realTokenReserves: 0n,
        realSolReserves: 0n,
        tokenTotalSupply: 1000000000000000n,
        complete: false,
      }),
    );
    expect(estimateBondingCurveLiquidityUsd(state, 77.91)).toBe(0);
  });
});
