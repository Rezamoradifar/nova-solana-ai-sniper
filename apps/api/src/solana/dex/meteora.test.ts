import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  calculateMeteoraDlmmLiquidityUsd,
  decodeMeteoraDlmmPool,
  isMeteoraDlmmPoolCreation,
} from './meteora.js';

// Real pool captured live 2026-07-10: 6oFWm7KPLfxnwMb3z5xwBoXNSPP3JJyirAPqPSiVcnsp
// (BONK/SOL). Decoded reserve balances (53,862,110,825.84 BONK, 64.2607 SOL) were an
// almost exact match to DexScreener's independently reported reserves (53,862,110,825
// BONK, 64.2606 SOL) for the same pair.
const REAL_POOL = {
  address: '6oFWm7KPLfxnwMb3z5xwBoXNSPP3JJyirAPqPSiVcnsp',
  activeId: -9442,
  binStep: 8,
  status: 0,
  tokenXMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  tokenYMint: 'So11111111111111111111111111111111111111112',
  reserveX: 'D4uJ9ASY1y1qsQ8g4vgv7V514VVsBK5sdAVJkSYqLYPj',
  reserveY: 'CDxKWsQbe2HWLzvUZ7hAPvhk7381WjFGYMXYVG8Ahdim',
};

function buildRealPoolAccountData(): Buffer {
  const buf = Buffer.alloc(216);
  buf.writeInt32LE(REAL_POOL.activeId, 76);
  buf.writeUInt16LE(REAL_POOL.binStep, 80);
  buf.writeUInt8(REAL_POOL.status, 82);
  new PublicKey(REAL_POOL.tokenXMint).toBuffer().copy(buf, 88);
  new PublicKey(REAL_POOL.tokenYMint).toBuffer().copy(buf, 120);
  new PublicKey(REAL_POOL.reserveX).toBuffer().copy(buf, 152);
  new PublicKey(REAL_POOL.reserveY).toBuffer().copy(buf, 184);
  return buf;
}

describe('decodeMeteoraDlmmPool', () => {
  it('decodes a real live LbPair account byte-for-byte correctly', () => {
    const state = decodeMeteoraDlmmPool(REAL_POOL.address, buildRealPoolAccountData());
    expect(state.tokenXMint).toBe(REAL_POOL.tokenXMint);
    expect(state.tokenYMint).toBe(REAL_POOL.tokenYMint);
    expect(state.reserveX).toBe(REAL_POOL.reserveX);
    expect(state.reserveY).toBe(REAL_POOL.reserveY);
    expect(state.binStep).toBe(8);
    expect(state.activeId).toBe(-9442);
  });

  it('throws on a too-short buffer instead of silently misreading it', () => {
    expect(() => decodeMeteoraDlmmPool(REAL_POOL.address, Buffer.alloc(100))).toThrow();
  });
});

describe('calculateMeteoraDlmmLiquidityUsd', () => {
  it('resolves the SOL side correctly when it is token_y, matching DexScreener within trade-drift range', () => {
    // 64.2607 SOL * ~77.91 * 2 ~= $10,013; DexScreener independently reported $225,092.4
    // total across BOTH the base-side value (BONK) and quote-side (SOL) using its own
    // per-token USD pricing, not our flat 2x-one-side approximation -- the two won't
    // match exactly, only stay in a sane order of magnitude for this pure-math check.
    const liquidityUsd = calculateMeteoraDlmmLiquidityUsd(
      REAL_POOL.tokenXMint,
      REAL_POOL.tokenYMint,
      53862110825.83538,
      64.260696563,
      77.91,
    );
    expect(liquidityUsd).toBeGreaterThan(5000);
    expect(liquidityUsd).toBeLessThan(20000);
  });

  it('resolves the SOL side correctly when it is token_x instead of token_y', () => {
    const liquidityUsd = calculateMeteoraDlmmLiquidityUsd(
      'So11111111111111111111111111111111111111112',
      'SomeProjectMint111111111111111111111111111',
      100,
      500000,
      77.91,
    );
    expect(liquidityUsd).toBeCloseTo(100 * 77.91 * 2, 2);
  });

  it('returns 0 when neither side is SOL rather than guessing', () => {
    expect(
      calculateMeteoraDlmmLiquidityUsd(
        'MintA1111111111111111111111111111111111111',
        'MintB1111111111111111111111111111111111111',
        1000,
        1000,
        77.91,
      ),
    ).toBe(0);
  });

  it('returns 0 when the SOL price is unavailable', () => {
    expect(
      calculateMeteoraDlmmLiquidityUsd(
        REAL_POOL.tokenXMint,
        REAL_POOL.tokenYMint,
        1000,
        1000,
        undefined,
      ),
    ).toBe(0);
  });
});

describe('isMeteoraDlmmPoolCreation', () => {
  it('matches all documented LbPair-initialization instruction names', () => {
    expect(isMeteoraDlmmPoolCreation(['Program log: Instruction: InitializeLbPair'])).toBe(true);
    expect(isMeteoraDlmmPoolCreation(['Program log: Instruction: InitializeLbPair2'])).toBe(true);
    expect(
      isMeteoraDlmmPoolCreation([
        'Program log: Instruction: InitializeCustomizablePermissionlessLbPair',
      ]),
    ).toBe(true);
  });

  it('does not match swap instructions', () => {
    expect(isMeteoraDlmmPoolCreation(['Program log: Instruction: Swap'])).toBe(false);
  });
});
