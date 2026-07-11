import { PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  estimateLiquidityFromPriceImpact,
  resolveLiquidityUsd,
  resolveRecentActivity,
  RiskAnalyzer,
} from './riskAnalyzer.js';
import { getBondingCurveVaultAta } from '../solana/pumpfunBondingCurve.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

describe('resolveLiquidityUsd', () => {
  it('prefers DexScreener when it has a liquidity figure, even $0', () => {
    expect(
      resolveLiquidityUsd({
        dexScreenerLiquidityUsd: 0,
        nativeDexLiquidityUsd: 3000,
        bondingCurveLiquidityUsd: 5000,
        jupiterEstimateLiquidityUsd: 5000,
      }),
    ).toEqual({ liquidityUsd: 0, source: 'dexscreener' });
  });

  it('falls back to the native DEX reader when DexScreener has nothing, before the bonding curve or Jupiter estimate', () => {
    expect(
      resolveLiquidityUsd({
        dexScreenerLiquidityUsd: undefined,
        nativeDexLiquidityUsd: 14760.76,
        bondingCurveLiquidityUsd: 5000,
        jupiterEstimateLiquidityUsd: 999,
      }),
    ).toEqual({ liquidityUsd: 14760.76, source: 'native_dex' });
  });

  it('falls back to the bonding curve estimate when neither DexScreener nor the native reader have anything', () => {
    expect(
      resolveLiquidityUsd({
        dexScreenerLiquidityUsd: undefined,
        nativeDexLiquidityUsd: undefined,
        bondingCurveLiquidityUsd: 107.71,
        jupiterEstimateLiquidityUsd: 999,
      }),
    ).toEqual({ liquidityUsd: 107.71, source: 'pumpfun_bonding_curve' });
  });

  it('falls back to the Jupiter estimate only when every other source is unavailable', () => {
    expect(
      resolveLiquidityUsd({
        dexScreenerLiquidityUsd: undefined,
        nativeDexLiquidityUsd: undefined,
        bondingCurveLiquidityUsd: undefined,
        jupiterEstimateLiquidityUsd: 250,
      }),
    ).toEqual({ liquidityUsd: 250, source: 'jupiter_estimate' });
  });

  it('reports 0 as unavailable (not silently as a real dexscreener 0) when every source fails', () => {
    expect(
      resolveLiquidityUsd({
        dexScreenerLiquidityUsd: undefined,
        nativeDexLiquidityUsd: undefined,
        bondingCurveLiquidityUsd: undefined,
        jupiterEstimateLiquidityUsd: undefined,
      }),
    ).toEqual({ liquidityUsd: 0, source: 'unavailable' });
  });
});

describe('resolveRecentActivity', () => {
  it('returns nothing when there is no pair at all', () => {
    expect(resolveRecentActivity(undefined)).toEqual({});
  });

  it('uses the m5 window when it has any real activity', () => {
    const pair = {
      txns: { m5: { buys: 3, sells: 1 }, h1: { buys: 40, sells: 38 } },
      volume: { m5: 120, h1: 900 },
    } as never;
    expect(resolveRecentActivity(pair)).toEqual({
      recentBuys: 3,
      recentSells: 1,
      recentVolumeUsd: 120,
    });
  });

  it('falls back to h1 when m5 is all-zero (typical for a token in its first minutes)', () => {
    const pair = {
      txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 4, sells: 3 } },
      volume: { m5: 0, h1: 301.45 },
    } as never;
    expect(resolveRecentActivity(pair)).toEqual({
      recentBuys: 4,
      recentSells: 3,
      recentVolumeUsd: 301.45,
    });
  });

  it('falls back to h1 when txns.m5 is absent entirely', () => {
    const pair = { txns: { h1: { buys: 5, sells: 2 } }, volume: { h1: 50 } } as never;
    expect(resolveRecentActivity(pair)).toEqual({
      recentBuys: 5,
      recentSells: 2,
      recentVolumeUsd: 50,
    });
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

  it('falls back to the native DEX reader when a known dex+poolAddress is passed and DexScreener has nothing', async () => {
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const jupiter = { getQuote: vi.fn() } as never;
    const connection = { getAccountInfo: vi.fn().mockResolvedValue(null) } as never;
    const dexRegistry = {
      getLiquidity: vi.fn().mockResolvedValue({
        dex: 'RAYDIUM',
        poolAddress: 'Pool1111111111111111111111111111111111111',
        baseMint: 'MintAAAA',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseReserve: 1000,
        quoteReserve: 5,
        liquidityUsd: 14760.76,
      }),
    } as never;

    const analyzer = new RiskAnalyzer(connection, dexScreener, jupiter, fakeLogger(), dexRegistry);
    const result = await analyzer.analyze({
      mint: 'MintAAAA',
      dex: 'RAYDIUM',
      poolAddress: 'Pool1111111111111111111111111111111111111',
    });

    expect(result.liquidityUsd).toBe(14760.76);
    expect(
      (dexRegistry as { getLiquidity: ReturnType<typeof vi.fn> }).getLiquidity,
    ).toHaveBeenCalledWith('RAYDIUM', 'Pool1111111111111111111111111111111111111');
    expect((jupiter as { getQuote: ReturnType<typeof vi.fn> }).getQuote).not.toHaveBeenCalled();
  });

  it('passes the bonding curve vault plus the native pool vaults to getHolderConcentration, excluding both from the count', async () => {
    const { getHolderConcentration } = await import('./onchain.js');
    const mint = '8Jexwtd8Py1g2bkjhQXPXoSztf5WEBAHvdLb7gUmpump';
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const jupiter = { getQuote: vi.fn() } as never;
    const connection = { getAccountInfo: vi.fn().mockResolvedValue(null) } as never;
    const dexRegistry = {
      getLiquidity: vi.fn().mockResolvedValue(undefined),
      getVaultAddresses: vi.fn().mockResolvedValue(['PoolVaultA', 'PoolVaultB']),
    } as never;

    const analyzer = new RiskAnalyzer(connection, dexScreener, jupiter, fakeLogger(), dexRegistry);
    await analyzer.analyze({ mint, dex: 'RAYDIUM', poolAddress: 'Pool111' });

    const expectedBondingCurveVault = getBondingCurveVaultAta(new PublicKey(mint)).toBase58();
    expect(vi.mocked(getHolderConcentration)).toHaveBeenCalledWith(
      connection,
      mint,
      1_000_000_000n, // mintAuthority's supply, threaded through instead of a redundant getTokenSupply call
      [expectedBondingCurveVault, 'PoolVaultA', 'PoolVaultB'],
    );
  });

  it('skips getHolderConcentration and falls back to conservative values when the mint-authority fetch itself fails', async () => {
    const { getMintAuthorityInfo, getHolderConcentration } = await import('./onchain.js');
    vi.mocked(getHolderConcentration).mockClear();
    vi.mocked(getMintAuthorityInfo).mockRejectedValueOnce(new Error('rpc blip'));
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const jupiter = { getQuote: vi.fn() } as never;
    const connection = { getAccountInfo: vi.fn().mockResolvedValue(null) } as never;

    const analyzer = new RiskAnalyzer(connection, dexScreener, jupiter, fakeLogger());
    const result = await analyzer.analyze({ mint: 'MintFetchFailed' });

    expect(vi.mocked(getHolderConcentration)).not.toHaveBeenCalled();
    expect(result.top10HolderPercent).toBe(100);
    expect(result.holderCount).toBe(0);
    expect(result.isHoneypotSuspected).toBe(true);
  });

  it('skips the Jupiter liquidity-estimate quote when mint authority is not revoked — already honeypot-suspected regardless of the liquidity figure', async () => {
    const { getMintAuthorityInfo } = await import('./onchain.js');
    vi.mocked(getMintAuthorityInfo).mockResolvedValueOnce({
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: true,
      decimals: 6,
      supply: 1_000_000_000n,
    });
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const jupiter = { getQuote: vi.fn() } as never;
    const connection = { getAccountInfo: vi.fn().mockResolvedValue(null) } as never;

    const analyzer = new RiskAnalyzer(connection, dexScreener, jupiter, fakeLogger());
    const result = await analyzer.analyze({ mint: 'MintNotRevoked' });

    expect((jupiter as { getQuote: ReturnType<typeof vi.fn> }).getQuote).not.toHaveBeenCalled();
    expect(result.liquiditySource).toBe('unavailable');
    expect(result.isHoneypotSuspected).toBe(true);
  });

  it('skips the native DEX reader when no dexRegistry was injected, falling through to the next source', async () => {
    const dexScreener = {
      getBestSolanaPair: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ priceUsd: '77.91' }),
    } as never;
    const jupiter = {
      getQuote: vi
        .fn()
        .mockResolvedValue({ priceImpactPct: '2', inAmount: '1', outAmount: '1', routePlan: [] }),
    } as never;
    const connection = { getAccountInfo: vi.fn().mockResolvedValue(null) } as never;

    // No dexRegistry passed at all — analyzer must not throw, just skip that source.
    const analyzer = new RiskAnalyzer(connection, dexScreener, jupiter, fakeLogger());
    const result = await analyzer.analyze({
      mint: 'MintAAAA',
      dex: 'RAYDIUM',
      poolAddress: 'Pool111',
    });

    expect(result.liquidityUsd).toBeGreaterThan(0);
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
