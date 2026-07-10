import { describe, expect, it, vi } from 'vitest';
import {
  estimateLiquidityFromPriceImpact,
  resolveLiquidityUsd,
  RiskAnalyzer,
} from './riskAnalyzer.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

describe('resolveLiquidityUsd', () => {
  it('prefers DexScreener when it has a liquidity figure, even $0', () => {
    expect(
      resolveLiquidityUsd({
        dexScreenerLiquidityUsd: 0,
        bondingCurveLiquidityUsd: 5000,
        jupiterEstimateLiquidityUsd: 5000,
      }),
    ).toEqual({ liquidityUsd: 0, source: 'dexscreener' });
  });

  it('falls back to the bonding curve estimate when DexScreener has no liquidity field at all', () => {
    expect(
      resolveLiquidityUsd({
        dexScreenerLiquidityUsd: undefined,
        bondingCurveLiquidityUsd: 107.71,
        jupiterEstimateLiquidityUsd: 999,
      }),
    ).toEqual({ liquidityUsd: 107.71, source: 'pumpfun_bonding_curve' });
  });

  it('falls back to the Jupiter estimate only when both other sources are unavailable', () => {
    expect(
      resolveLiquidityUsd({
        dexScreenerLiquidityUsd: undefined,
        bondingCurveLiquidityUsd: undefined,
        jupiterEstimateLiquidityUsd: 250,
      }),
    ).toEqual({ liquidityUsd: 250, source: 'jupiter_estimate' });
  });

  it('reports 0 as unavailable (not silently as a real dexscreener 0) when every source fails', () => {
    expect(
      resolveLiquidityUsd({
        dexScreenerLiquidityUsd: undefined,
        bondingCurveLiquidityUsd: undefined,
        jupiterEstimateLiquidityUsd: undefined,
      }),
    ).toEqual({ liquidityUsd: 0, source: 'unavailable' });
  });
});

describe('estimateLiquidityFromPriceImpact', () => {
  it('estimates pool liquidity from a small probe trade price impact', () => {
    // 0.5 SOL probe, $77.91/SOL, 1% impact => one side ~= $3895.5, both sides ~= $7791
    const estimate = estimateLiquidityFromPriceImpact(0.5, 77.91, 1);
    expect(estimate).toBeCloseTo(7791, 0);
  });

  it('returns undefined for zero or negligible price impact rather than dividing by ~0', () => {
    expect(estimateLiquidityFromPriceImpact(0.5, 77.91, 0)).toBeUndefined();
    expect(estimateLiquidityFromPriceImpact(0.5, 77.91, 0.00001)).toBeUndefined();
  });

  it('returns undefined for a non-finite price impact', () => {
    expect(estimateLiquidityFromPriceImpact(0.5, 77.91, NaN)).toBeUndefined();
  });
});

vi.mock('./onchain.js', () => ({
  getMintAuthorityInfo: vi.fn().mockResolvedValue({
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    decimals: 6,
    supply: 1_000_000_000n,
  }),
  getHolderConcentration: vi.fn().mockResolvedValue({ top10HolderPercent: 20, holderCount: 50 }),
}));

describe('RiskAnalyzer.analyze liquidity fallback chain', () => {
  it('uses DexScreener liquidity when present, without touching the chain or Jupiter', async () => {
    const dexScreener = {
      getBestSolanaPair: vi.fn().mockResolvedValue({ liquidity: { usd: 12345 } }),
    } as never;
    const jupiter = { getQuote: vi.fn() } as never;
    const connection = { getAccountInfo: vi.fn() } as never;

    const analyzer = new RiskAnalyzer(connection, dexScreener, jupiter, fakeLogger());
    const result = await analyzer.analyze({ mint: 'MintAAAA' });

    expect(result.liquidityUsd).toBe(12345);
    expect(
      (connection as { getAccountInfo: ReturnType<typeof vi.fn> }).getAccountInfo,
    ).not.toHaveBeenCalled();
    expect((jupiter as { getQuote: ReturnType<typeof vi.fn> }).getQuote).not.toHaveBeenCalled();
  });

  it('falls back to the bonding curve when DexScreener has a pair but no liquidity field (pump.fun case)', async () => {
    const dexScreener = {
      // real DexScreener response shape for dexId: "pumpfun" pairs: no `liquidity` key at all
      getBestSolanaPair: vi
        .fn()
        .mockResolvedValueOnce({ priceUsd: '0.000002', dexId: 'pumpfun' })
        .mockResolvedValueOnce({ priceUsd: '77.91', liquidity: { usd: 25_000_000 } }), // SOL/USDC lookup for pricing
    } as never;
    const jupiter = { getQuote: vi.fn() } as never;

    // 49-byte bonding curve account: 8-byte discriminator + 5 u64 + 1 bool
    const data = Buffer.alloc(49);
    data.writeBigUInt64LE(691_250_005n, 32); // realSolReserves offset
    data.writeUInt8(0, 48); // complete = false
    const connection = {
      getAccountInfo: vi.fn().mockResolvedValue({ data }),
    } as never;

    const analyzer = new RiskAnalyzer(connection, dexScreener, jupiter, fakeLogger());
    const result = await analyzer.analyze({ mint: '8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump' });

    expect(result.liquidityUsd).toBeGreaterThan(0);
    expect((jupiter as { getQuote: ReturnType<typeof vi.fn> }).getQuote).not.toHaveBeenCalled();
  });

  it('falls back all the way to the Jupiter estimate when neither DexScreener nor the bonding curve produce a number', async () => {
    const dexScreener = {
      getBestSolanaPair: vi
        .fn()
        .mockResolvedValueOnce(undefined) // no dexscreener pair at all
        .mockResolvedValueOnce({ priceUsd: '77.91' }), // SOL price lookup (bonding curve attempt)
      // second attempt: SOL price lookup for jupiter estimate — cached from the first call,
      // so getBestSolanaPair for SOL only needs to resolve once in practice, but mock is lenient.
    } as never;
    const jupiter = {
      getQuote: vi
        .fn()
        .mockResolvedValue({ priceImpactPct: '2', inAmount: '1', outAmount: '1', routePlan: [] }),
    } as never;
    const connection = {
      getAccountInfo: vi.fn().mockResolvedValue(null), // no bonding curve account (already migrated or nonexistent)
    } as never;

    const analyzer = new RiskAnalyzer(connection, dexScreener, jupiter, fakeLogger());
    const result = await analyzer.analyze({ mint: 'MintNoBondingCurve' });

    expect(result.liquidityUsd).toBeGreaterThan(0);
    expect((jupiter as { getQuote: ReturnType<typeof vi.fn> }).getQuote).toHaveBeenCalled();
  });

  it('reports 0 (not a crash) when every liquidity source is unavailable', async () => {
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const jupiter = { getQuote: vi.fn().mockRejectedValue(new Error('no route')) } as never;
    const connection = { getAccountInfo: vi.fn().mockResolvedValue(null) } as never;

    const analyzer = new RiskAnalyzer(connection, dexScreener, jupiter, fakeLogger());
    const result = await analyzer.analyze({ mint: 'MintDead' });

    expect(result.liquidityUsd).toBe(0);
  });
});
