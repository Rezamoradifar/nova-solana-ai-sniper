import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketDataClient, dexScreenerTokenUrl } from './marketData.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('dexScreenerTokenUrl', () => {
  it('builds the real, direct DexScreener URL — no redirect/shortener', () => {
    expect(dexScreenerTokenUrl('MintX')).toBe('https://dexscreener.com/solana/MintX');
  });
});

describe('MarketDataClient.fetchEnrichment', () => {
  it('picks the deepest-liquidity Solana pair and maps real fields', async () => {
    const pairs = [
      {
        chainId: 'solana',
        liquidity: { usd: 100 },
        marketCap: 1000,
        volume: { h24: 500 },
        priceChange: { h1: 12 },
      },
      {
        chainId: 'solana',
        liquidity: { usd: 9000 },
        marketCap: 50_000,
        volume: { h24: 20_000 },
        priceChange: { h1: 34 },
        info: { imageUrl: 'https://example.com/logo.png' },
      },
      { chainId: 'ethereum', liquidity: { usd: 999_999 } },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => pairs }));

    const client = new MarketDataClient('https://api.dexscreener.com');
    const result = await client.fetchEnrichment('MintAbc');

    expect(result).toEqual({
      logoUrl: 'https://example.com/logo.png',
      liquidityUsd: 9000,
      marketCapUsd: 50_000,
      volume24hUsd: 20_000,
      priceChangeH1Percent: 34,
      chain: 'Solana',
      dexScreenerUrl: 'https://dexscreener.com/solana/MintAbc',
    });
  });

  it('falls back to fdv when marketCap is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ chainId: 'solana', liquidity: { usd: 1 }, fdv: 777 }],
      }),
    );
    const client = new MarketDataClient('https://api.dexscreener.com');
    const result = await client.fetchEnrichment('MintAbc');
    expect(result?.marketCapUsd).toBe(777);
  });

  it('returns undefined on a non-2xx response rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const client = new MarketDataClient('https://api.dexscreener.com');
    expect(await client.fetchEnrichment('MintAbc')).toBeUndefined();
  });

  it('returns undefined on a network error/timeout rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const client = new MarketDataClient('https://api.dexscreener.com');
    expect(await client.fetchEnrichment('MintAbc')).toBeUndefined();
  });

  it('returns undefined when no Solana pair exists in the response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => [{ chainId: 'ethereum', liquidity: { usd: 1 } }],
        }),
    );
    const client = new MarketDataClient('https://api.dexscreener.com');
    expect(await client.fetchEnrichment('MintAbc')).toBeUndefined();
  });
});
