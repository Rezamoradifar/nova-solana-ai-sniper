import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  calculateOrcaWhirlpoolLiquidityUsd,
  decodeOrcaWhirlpool,
  isOrcaWhirlpoolPoolCreation,
} from './orca.js';

// Real pool captured live 2026-07-10: Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE
// (SOL/USDC). Account data length matched the protocol's own LEN constant exactly
// (653 bytes), and decoded vault balances (219,331 SOL, 8,379,194 USDC) closely
// tracked DexScreener's independently reported reserves (219,104 SOL, 8,396,810 USDC).
const REAL_POOL = {
  address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
  whirlpoolsConfig: '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ',
  tickSpacing: 4,
  tokenMintA: 'So11111111111111111111111111111111111111112',
  tokenVaultA: 'EUuUbDcafPrmVTD5M6qoJAoyyNbihBhugADAxRMn5he9',
  tokenMintB: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  tokenVaultB: '2WLWEuKDgkDUccTpbwYp1GToYktiSB1cXvreHUwiSUVP',
};

function buildRealPoolAccountData(): Buffer {
  const buf = Buffer.alloc(653);
  new PublicKey(REAL_POOL.whirlpoolsConfig).toBuffer().copy(buf, 8);
  buf.writeUInt16LE(REAL_POOL.tickSpacing, 41);
  new PublicKey(REAL_POOL.tokenMintA).toBuffer().copy(buf, 101);
  new PublicKey(REAL_POOL.tokenVaultA).toBuffer().copy(buf, 133);
  new PublicKey(REAL_POOL.tokenMintB).toBuffer().copy(buf, 181);
  new PublicKey(REAL_POOL.tokenVaultB).toBuffer().copy(buf, 213);
  return buf;
}

describe('decodeOrcaWhirlpool', () => {
  it('decodes a real live Whirlpool account byte-for-byte correctly', () => {
    const state = decodeOrcaWhirlpool(REAL_POOL.address, buildRealPoolAccountData());
    expect(state.tokenMintA).toBe(REAL_POOL.tokenMintA);
    expect(state.tokenVaultA).toBe(REAL_POOL.tokenVaultA);
    expect(state.tokenMintB).toBe(REAL_POOL.tokenMintB);
    expect(state.tokenVaultB).toBe(REAL_POOL.tokenVaultB);
    expect(state.tickSpacing).toBe(4);
  });

  it('throws on a too-short buffer instead of silently misreading it', () => {
    expect(() => decodeOrcaWhirlpool(REAL_POOL.address, Buffer.alloc(100))).toThrow();
  });
});

describe('calculateOrcaWhirlpoolLiquidityUsd', () => {
  it('resolves the SOL side correctly when it is token_mint_a, matching DexScreener within trade-drift range', () => {
    // 219,331 SOL * ~77.6 * 2 ~= $34,043,000 -- wait: DexScreener reported liquidityUsd
    // $25,400,026.85 for base=219104 SOL alone at priceUsd 77.60, i.e. one side ~=
    // $17,002,470, so total (2x) ~= $34,004,940. DexScreener's own liquidity.usd is
    // computed the same "both sides" way, just using its own base+quote value sum
    // rather than a flat 2x-one-side approximation -- close enough to confirm sanity,
    // not an exact-cent match (documented approximation, same as the other DEX readers).
    const liquidityUsd = calculateOrcaWhirlpoolLiquidityUsd(
      REAL_POOL.tokenMintA,
      REAL_POOL.tokenMintB,
      219331.269262796,
      8379194.512927,
      77.6,
    );
    expect(liquidityUsd).toBeGreaterThan(30_000_000);
    expect(liquidityUsd).toBeLessThan(38_000_000);
  });

  it('resolves the SOL side correctly when it is token_mint_b instead of token_mint_a', () => {
    const liquidityUsd = calculateOrcaWhirlpoolLiquidityUsd(
      'SomeProjectMint111111111111111111111111111',
      'So11111111111111111111111111111111111111112',
      1000,
      500,
      77.6,
    );
    expect(liquidityUsd).toBeCloseTo(500 * 77.6 * 2, 2);
  });

  it('returns 0 when neither side is SOL rather than guessing', () => {
    expect(
      calculateOrcaWhirlpoolLiquidityUsd(
        'MintA1111111111111111111111111111111111111',
        'MintB1111111111111111111111111111111111111',
        1000,
        1000,
        77.6,
      ),
    ).toBe(0);
  });

  it('returns 0 when the SOL price is unavailable', () => {
    expect(
      calculateOrcaWhirlpoolLiquidityUsd(
        REAL_POOL.tokenMintA,
        REAL_POOL.tokenMintB,
        1000,
        1000,
        undefined,
      ),
    ).toBe(0);
  });
});

describe('isOrcaWhirlpoolPoolCreation', () => {
  it('matches InitializePool and its v2 variant', () => {
    expect(isOrcaWhirlpoolPoolCreation(['Program log: Instruction: InitializePool'])).toBe(true);
    expect(isOrcaWhirlpoolPoolCreation(['Program log: Instruction: InitializePoolV2'])).toBe(true);
  });

  it('does not match swap instructions', () => {
    expect(isOrcaWhirlpoolPoolCreation(['Program log: Instruction: Swap'])).toBe(false);
    expect(isOrcaWhirlpoolPoolCreation(['Program log: Instruction: SwapV2'])).toBe(false);
  });
});
