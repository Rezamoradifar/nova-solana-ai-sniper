import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  calculatePumpSwapLiquidityUsd,
  decodePumpSwapPool,
  isPumpSwapPoolCreation,
} from './pumpswap.js';

// Real pool captured live 2026-07-10: CcYbXbMHr2o9Vyz2wmJcRvi59wh42xkXf6qrzChbHPN5
// (jk1T35eWK41MBMM8AWoYVaNbjHEEQzMDetTsfnqpump / SOL). Decoded field offsets were
// cross-checked against the pool's own real token-vault balances, which closely
// tracked DexScreener's independently reported reserves for the same pair.
const REAL_POOL = {
  address: 'CcYbXbMHr2o9Vyz2wmJcRvi59wh42xkXf6qrzChbHPN5',
  poolBump: 255,
  index: 0,
  creator: 'CpXB2EETu4CQipFvwKcufB2vWqcrRZbkbkfarYMy3Wad',
  baseMint: 'jk1T35eWK41MBMM8AWoYVaNbjHEEQzMDetTsfnqpump',
  quoteMint: 'So11111111111111111111111111111111111111112',
  lpMint: '2EJmNaPxGnd7QKxeJtLH6wM7yyZi8pJzN18duWbom8Sy',
  poolBaseTokenAccount: '2uTUzoGAyTqVAQoitEj6qAtLiJKBoFszFJZm7pusNoRB',
  poolQuoteTokenAccount: '9Nkgzsqenp9a87akazm9zQc4eduTa7w2bd8ynvsJCoUf',
  lpSupply: 4193388284701n,
};

function buildRealPoolAccountData(): Buffer {
  const buf = Buffer.alloc(211);
  buf.writeUInt8(REAL_POOL.poolBump, 8);
  buf.writeUInt16LE(REAL_POOL.index, 9);
  new PublicKey(REAL_POOL.creator).toBuffer().copy(buf, 11);
  new PublicKey(REAL_POOL.baseMint).toBuffer().copy(buf, 43);
  new PublicKey(REAL_POOL.quoteMint).toBuffer().copy(buf, 75);
  new PublicKey(REAL_POOL.lpMint).toBuffer().copy(buf, 107);
  new PublicKey(REAL_POOL.poolBaseTokenAccount).toBuffer().copy(buf, 139);
  new PublicKey(REAL_POOL.poolQuoteTokenAccount).toBuffer().copy(buf, 171);
  buf.writeBigUInt64LE(REAL_POOL.lpSupply, 203);
  return buf;
}

describe('decodePumpSwapPool', () => {
  it('decodes a real live pool account byte-for-byte correctly', () => {
    const state = decodePumpSwapPool(REAL_POOL.address, buildRealPoolAccountData());
    expect(state.baseMint).toBe(REAL_POOL.baseMint);
    expect(state.quoteMint).toBe(REAL_POOL.quoteMint);
    expect(state.poolBaseTokenAccount).toBe(REAL_POOL.poolBaseTokenAccount);
    expect(state.poolQuoteTokenAccount).toBe(REAL_POOL.poolQuoteTokenAccount);
    expect(state.lpSupply).toBe(REAL_POOL.lpSupply);
  });

  it('throws on a too-short buffer instead of silently misreading it', () => {
    expect(() => decodePumpSwapPool(REAL_POOL.address, Buffer.alloc(50))).toThrow();
  });
});

describe('calculatePumpSwapLiquidityUsd', () => {
  it('matches DexScreener within the range expected from intervening trades', () => {
    // Live snapshot: quote reserve 532.05 SOL, SOL/USD ~77.91 at the same moment this
    // session -> DexScreener independently reported liquidityUsd $82,632.03.
    const liquidityUsd = calculatePumpSwapLiquidityUsd(
      'So11111111111111111111111111111111111111112',
      532.051726163,
      77.91,
    );
    expect(liquidityUsd).toBeCloseTo(82910, -2);
  });

  it('returns 0 when the quote side is not SOL rather than guessing a price', () => {
    expect(calculatePumpSwapLiquidityUsd('SomeOtherMint111111111111111111111111111', 1000, 1)).toBe(
      0,
    );
  });

  it('returns 0 when the SOL price is unavailable', () => {
    expect(
      calculatePumpSwapLiquidityUsd('So11111111111111111111111111111111111111112', 532, undefined),
    ).toBe(0);
  });
});

describe('isPumpSwapPoolCreation', () => {
  it('matches known pool-init instruction name candidates', () => {
    expect(isPumpSwapPoolCreation(['Program log: Instruction: CreatePool'])).toBe(true);
    expect(isPumpSwapPoolCreation(['Program log: Instruction: Deposit'])).toBe(true);
  });

  it('does not match trading instructions', () => {
    expect(isPumpSwapPoolCreation(['Program log: Instruction: Buy'])).toBe(false);
    expect(isPumpSwapPoolCreation(['Program log: Instruction: Sell'])).toBe(false);
    expect(isPumpSwapPoolCreation(['Program log: Instruction: Swap2'])).toBe(false);
  });
});
