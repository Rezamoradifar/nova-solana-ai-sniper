import { describe, expect, it } from 'vitest';
import { MARKET_TOKENS, selectMarkets } from './publicMarket.js';

const mint = MARKET_TOKENS[0].mint;
function pair(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    pairAddress: 'PoolA',
    url: 'https://dexscreener.com/solana/PoolA',
    baseToken: { address: mint, symbol: 'SOL', name: 'Solana' },
    quoteToken: { address: 'USDCMint', symbol: 'USDC' },
    priceUsd: '150.25',
    liquidity: { usd: 1_000 },
    volume: { h24: 300 },
    priceChange: { h24: -2.5 },
    ...overrides,
  };
}

describe('public market data normalization', () => {
  it('uses the deepest pool price while summing each distinct valid pool once', () => {
    const a = pair();
    const b = pair({
      pairAddress: 'PoolB',
      priceUsd: '151',
      liquidity: { usd: 2_000 },
      volume: { h24: 400 },
    });
    const [market] = selectMarkets([
      a,
      a,
      b,
      pair({ chainId: 'ethereum' }),
      pair({ baseToken: { address: 'UnknownMint' } }),
    ]);
    expect(market).toMatchObject({ mint, price: 151, volume: 700, liquidity: 3_000, change: -2.5 });
    expect(market?.pairs.map((p) => p.pairAddress)).toEqual(['PoolB', 'PoolA']);
  });

  it('accepts decimal and scientific price strings and treats unavailable change as unknown', () => {
    expect(selectMarkets([pair({ priceUsd: '1e-8', priceChange: { h24: NaN } })])[0]).toMatchObject(
      { price: 1e-8, change: null },
    );
  });

  it.each([true, [2], {}, '', '0x10', 'Infinity', 'NaN', '0', '-2'])(
    'rejects malformed price %j rather than coercing it to a market value',
    (priceUsd) => {
      expect(selectMarkets([pair({ priceUsd })])).toEqual([]);
    },
  );

  it('does not let negative or non-finite volume distort the aggregate', () => {
    const [market] = selectMarkets([
      pair({ volume: { h24: -100 } }),
      pair({ pairAddress: 'PoolB', volume: { h24: 25 } }),
      pair({ pairAddress: 'PoolC', volume: { h24: Infinity } }),
    ]);
    expect(market?.volume).toBe(25);
  });

  it.each([
    { pairAddress: '' },
    { dexId: ' ' },
    { quoteToken: { address: '', symbol: 'USDC' } },
    { liquidity: { usd: -1 } },
    { liquidity: { usd: Infinity } },
  ])('ignores unusable pool data: %j', (invalid) => {
    expect(selectMarkets([null, 42, pair(invalid)])).toEqual([]);
  });

  it('surfaces an invalid top-level response as unavailable rather than an empty success', () => {
    expect(() => selectMarkets({ error: 'upstream error' })).toThrow('temporarily unavailable');
  });
});
