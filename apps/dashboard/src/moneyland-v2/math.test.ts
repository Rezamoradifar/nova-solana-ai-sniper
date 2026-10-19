import { describe, expect, it } from 'vitest';
import { evaluateFlashCosts, indicativeSwapOutput } from './math.js';

describe('indicativeSwapOutput', () => {
  it('converts a cross-rate for display only', () => {
    expect(indicativeSwapOutput(2, 150, 1)).toBe(300);
    expect(indicativeSwapOutput(1, 25, 5)).toBe(5);
  });
  it('refuses unavailable, invalid and zero-rate inputs', () => {
    expect(indicativeSwapOutput(1, undefined, 1)).toBeNull();
    expect(indicativeSwapOutput(1, 10, 0)).toBeNull();
    expect(indicativeSwapOutput(0, 10, 1)).toBeNull();
    expect(indicativeSwapOutput(Number.NaN, 10, 1)).toBeNull();
    expect(indicativeSwapOutput(1, Infinity, 1)).toBeNull();
  });
});

describe('evaluateFlashCosts', () => {
  const valid = {
    principal: 10_000,
    edgePercent: 0.4,
    loanFeePercent: 0.05,
    gasAllowanceUsd: 15,
    slippagePercent: 0.15,
  };
  it('subtracts fee, gas and slippage from the gross spread model', () => {
    const result = evaluateFlashCosts(valid);
    expect(result).not.toBeNull();
    expect(result?.grossUsd).toBeCloseTo(40);
    expect(result?.loanFeeUsd).toBeCloseTo(5);
    expect(result?.slippageAllowanceUsd).toBeCloseTo(15);
    expect(result?.netUsd).toBeCloseTo(5);
  });
  it('allows a negative modeled return without calling it a guaranteed loss', () => {
    const result = evaluateFlashCosts({ ...valid, edgePercent: 0.01 });
    expect(result?.netUsd).toBeLessThan(0);
  });
  it('rejects impossible parameters and floating-point overflow', () => {
    expect(evaluateFlashCosts({ ...valid, principal: 0 })).toBeNull();
    expect(evaluateFlashCosts({ ...valid, gasAllowanceUsd: -1 })).toBeNull();
    expect(evaluateFlashCosts({ ...valid, loanFeePercent: 11 })).toBeNull();
    expect(evaluateFlashCosts({ ...valid, edgePercent: Infinity })).toBeNull();
    expect(evaluateFlashCosts({ ...valid, principal: Number.NaN })).toBeNull();
  });
});
