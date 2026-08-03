import { describe, expect, it, vi } from 'vitest';
import { NativeDexAdapter } from './adapter.js';
import { NotImplementedNativeExecutor } from './types.js';
import type { DexScreenerPair } from '../dexscreener.js';

function pair(overrides: Partial<DexScreenerPair> = {}): DexScreenerPair {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    pairAddress: 'Pair1',
    baseToken: { address: 'MintA', name: 'A', symbol: 'A' },
    quoteToken: {
      address: 'So11111111111111111111111111111111111111112',
      name: 'SOL',
      symbol: 'SOL',
    },
    liquidity: { usd: 1000 },
    volume: { m5: 10, h1: 100, h24: 1000 },
    txns: { m5: { buys: 5, sells: 2 }, h1: { buys: 50, sells: 20 } },
    ...overrides,
  };
}

function fakeAdapter(
  dex: 'RAYDIUM' | 'PUMPSWAP' = 'RAYDIUM',
  overrides: {
    liquidityReader?: ReturnType<typeof vi.fn>;
    getPairsForToken?: ReturnType<typeof vi.fn>;
    executor?: { dex: string; buildSwap: ReturnType<typeof vi.fn> };
  } = {},
) {
  const liquidityReader = overrides.liquidityReader ?? vi.fn();
  const getPairsForToken = overrides.getPairsForToken ?? vi.fn().mockResolvedValue([]);
  const dexScreener = { getPairsForToken } as never;
  const executor = overrides.executor ?? new NotImplementedNativeExecutor(dex);
  const adapter = new NativeDexAdapter(
    dex,
    {} as never,
    dexScreener,
    {} as never,
    liquidityReader,
    executor as never,
  );
  return { adapter, liquidityReader, getPairsForToken, executor };
}

describe('NativeDexAdapter', () => {
  it('getLiquidity maps the liquidity reader result to LiquidityData', async () => {
    const { adapter, liquidityReader } = fakeAdapter();
    liquidityReader.mockResolvedValue({
      dex: 'RAYDIUM',
      poolAddress: 'PoolA',
      baseMint: 'MintA',
      quoteMint: 'So11111111111111111111111111111111111111112',
      baseReserve: 5,
      quoteReserve: 10,
      liquidityUsd: 500,
    });

    expect(await adapter.getLiquidity('PoolA')).toEqual({
      liquidityUsd: 500,
      baseReserve: 5,
      quoteReserve: 10,
    });
  });

  it('getLiquidity returns undefined when the reader finds nothing', async () => {
    const { adapter, liquidityReader } = fakeAdapter();
    liquidityReader.mockResolvedValue(undefined);
    expect(await adapter.getLiquidity('PoolA')).toBeUndefined();
  });

  it("getVolume/getOrderFlow only consider this adapter's own DEX, not the deepest pair overall", async () => {
    const { adapter, getPairsForToken } = fakeAdapter('RAYDIUM');
    getPairsForToken.mockResolvedValue([
      pair({ dexId: 'pumpswap', liquidity: { usd: 999_999 }, volume: { m5: 1, h1: 1, h24: 1 } }), // deeper but wrong DEX
      pair({ dexId: 'raydium', liquidity: { usd: 100 }, volume: { m5: 10, h1: 100, h24: 1000 } }),
    ]);

    const volume = await adapter.getVolume('MintA');
    expect(volume).toEqual({ volumeUsd5m: 10, volumeUsd1h: 100, volumeUsd24h: 1000 });

    const orderFlow = await adapter.getOrderFlow('MintA');
    expect(orderFlow).toEqual({ buys5m: 5, sells5m: 2, buys1h: 50, sells1h: 20 });
  });

  it('picks the deepest pair when this mint has multiple pools on the same DEX', async () => {
    const { adapter, getPairsForToken } = fakeAdapter('RAYDIUM');
    getPairsForToken.mockResolvedValue([
      pair({ dexId: 'raydium', liquidity: { usd: 50 }, volume: { m5: 1, h1: 1, h24: 1 } }),
      pair({
        dexId: 'raydium clmm',
        liquidity: { usd: 500 },
        volume: { m5: 20, h1: 200, h24: 2000 },
      }),
    ]);
    expect(await adapter.getVolume('MintA')).toEqual({
      volumeUsd5m: 20,
      volumeUsd1h: 200,
      volumeUsd24h: 2000,
    });
  });

  it('getVolume/getOrderFlow return undefined when no pair exists on this DEX', async () => {
    const { adapter, getPairsForToken } = fakeAdapter('METEORA' as never);
    getPairsForToken.mockResolvedValue([pair({ dexId: 'raydium' })]);
    expect(await adapter.getVolume('MintA')).toBeUndefined();
    expect(await adapter.getOrderFlow('MintA')).toBeUndefined();
  });

  it('ignores a non-solana chain pair even if the dexId matches', async () => {
    const { adapter, getPairsForToken } = fakeAdapter('RAYDIUM');
    getPairsForToken.mockResolvedValue([pair({ dexId: 'raydium', chainId: 'ethereum' })]);
    expect(await adapter.getVolume('MintA')).toBeUndefined();
  });

  it('missing volume/txns fields default to 0 rather than undefined/NaN', async () => {
    const { adapter, getPairsForToken } = fakeAdapter('RAYDIUM');
    getPairsForToken.mockResolvedValue([pair({ dexId: 'raydium', volume: {}, txns: {} })]);
    expect(await adapter.getVolume('MintA')).toEqual({
      volumeUsd5m: 0,
      volumeUsd1h: 0,
      volumeUsd24h: 0,
    });
    expect(await adapter.getOrderFlow('MintA')).toEqual({
      buys5m: 0,
      sells5m: 0,
      buys1h: 0,
      sells1h: 0,
    });
  });

  it('isExecutable is false for the NotImplementedNativeExecutor stub', () => {
    const { adapter } = fakeAdapter();
    expect(adapter.isExecutable).toBe(false);
  });

  it('isExecutable is true for a real executor', () => {
    const { adapter } = fakeAdapter('RAYDIUM', {
      executor: { dex: 'RAYDIUM', buildSwap: vi.fn() },
    });
    expect(adapter.isExecutable).toBe(true);
  });

  it('executeSwap delegates to the executor and wraps the transaction', async () => {
    const fakeTx = { fake: true };
    const buildSwap = vi.fn().mockResolvedValue(fakeTx);
    const { adapter } = fakeAdapter('RAYDIUM', { executor: { dex: 'RAYDIUM', buildSwap } });

    const result = await adapter.executeSwap({} as never);
    expect(buildSwap).toHaveBeenCalled();
    expect(result).toEqual({ transaction: fakeTx });
  });

  it("executeSwap propagates the stub executor's loud rejection unmodified", async () => {
    const { adapter } = fakeAdapter('RAYDIUM');
    await expect(adapter.executeSwap({} as never)).rejects.toThrow(/No native RAYDIUM executor/);
  });
});
