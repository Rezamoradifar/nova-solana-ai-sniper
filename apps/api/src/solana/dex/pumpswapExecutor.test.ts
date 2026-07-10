import { describe, expect, it } from 'vitest';
import { applySlippageFloor, quoteConstantProduct } from './pumpswapExecutor.js';

describe('quoteConstantProduct', () => {
  it('matches the constant-product formula for a simple case', () => {
    // reserveIn=1000, reserveOut=1000, amountIn=100 => out = 1000*100/1100 ~= 90.9
    expect(quoteConstantProduct(1000n, 1000n, 100n)).toBe(90n);
  });

  it('returns a smaller amount for a larger trade relative to reserves (price impact)', () => {
    const smallTradeOut = quoteConstantProduct(1_000_000n, 1_000_000n, 1_000n);
    const bigTradeOut = quoteConstantProduct(1_000_000n, 1_000_000n, 500_000n);
    // Per-unit rate should be worse for the big trade: bigTradeOut/500_000 < smallTradeOut/1_000
    expect(Number(bigTradeOut) / 500_000).toBeLessThan(Number(smallTradeOut) / 1_000);
  });

  it('returns 0 for empty reserves or a non-positive input rather than dividing by zero', () => {
    expect(quoteConstantProduct(0n, 1000n, 100n)).toBe(0n);
    expect(quoteConstantProduct(1000n, 0n, 100n)).toBe(0n);
    expect(quoteConstantProduct(1000n, 1000n, 0n)).toBe(0n);
  });
});

describe('applySlippageFloor', () => {
  it('discounts an amount by the given basis points', () => {
    expect(applySlippageFloor(1000n, 500)).toBe(950n); // 5%
    expect(applySlippageFloor(1000n, 0)).toBe(1000n);
    expect(applySlippageFloor(1000n, 10_000)).toBe(0n); // 100% -> nothing left
  });

  it('clamps out-of-range basis points instead of producing a negative or inflated result', () => {
    expect(applySlippageFloor(1000n, -50)).toBe(1000n);
    expect(applySlippageFloor(1000n, 20_000)).toBe(0n);
  });
});
