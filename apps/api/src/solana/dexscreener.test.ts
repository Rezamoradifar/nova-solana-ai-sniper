import { describe, expect, it, vi, afterEach } from 'vitest';
import { DexScreenerClient, type DexScreenerPair } from './dexscreener.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fakePair(mint: string, liquidityUsd = 1000): DexScreenerPair {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    pairAddress: `pair-${mint}`,
    baseToken: { address: mint, name: 'Test', symbol: 'TEST' },
    quoteToken: {
      address: 'So11111111111111111111111111111111111111112',
      name: 'SOL',
      symbol: 'SOL',
    },
    liquidity: { usd: liquidityUsd },
  };
}

function stubFetchReturning(pairs: DexScreenerPair[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(pairs), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('DexScreenerClient caching + in-flight dedup', () => {
  it('collapses concurrent calls for the same mint within the TTL into one fetch', async () => {
    const fetchMock = stubFetchReturning([fakePair('MintA')]);
    const client = new DexScreenerClient('https://api.example.com', 2_500, 4_000);

    const [a, b] = await Promise.all([
      client.getPairsForToken('MintA'),
      client.getPairsForToken('MintA'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('never coalesces distinct mints', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      const mint = url.includes('MintA') ? 'MintA' : 'MintB';
      return new Response(JSON.stringify([fakePair(mint)]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new DexScreenerClient('https://api.example.com', 2_500, 4_000);

    await Promise.all([client.getPairsForToken('MintA'), client.getPairsForToken('MintB')]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-fetches once the TTL has expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchMock = stubFetchReturning([fakePair('MintA')]);
    const client = new DexScreenerClient('https://api.example.com', 50, 4_000);

    await client.getPairsForToken('MintA');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 100);
    await client.getPairsForToken('MintA');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves cached results for repeated calls within the TTL window', async () => {
    const fetchMock = stubFetchReturning([fakePair('MintA')]);
    const client = new DexScreenerClient('https://api.example.com', 2_500, 4_000);

    await client.getPairsForToken('MintA');
    await client.getPairsForToken('MintA');
    await client.getPairsForToken('MintA');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a fetch that hangs past fetchTimeoutMs aborts and resolves to an empty array, not a hang or a crash', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new DexScreenerClient('https://api.example.com', 2_500, 20);

    const result = await client.getPairsForToken('MintA');
    expect(result).toEqual([]);
  });

  it('a genuine non-timeout fetch error still propagates (not silently swallowed to [])', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const client = new DexScreenerClient('https://api.example.com', 2_500, 4_000);

    await expect(client.getPairsForToken('MintA')).rejects.toThrow('network down');
  });

  it('a 404 still resolves to [] (existing precedent, unaffected by caching)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const client = new DexScreenerClient('https://api.example.com', 2_500, 4_000);

    expect(await client.getPairsForToken('MintA')).toEqual([]);
  });

  it('getBestSolanaPair still picks the deepest-liquidity solana pair through the cached path', async () => {
    stubFetchReturning([
      fakePair('MintA', 500),
      { ...fakePair('MintA', 900), chainId: 'ethereum' },
      { ...fakePair('MintA', 700), pairAddress: 'pair-2' },
    ]);
    const client = new DexScreenerClient('https://api.example.com', 2_500, 4_000);

    const best = await client.getBestSolanaPair('MintA');
    expect(best?.pairAddress).toBe('pair-2');
  });
});
