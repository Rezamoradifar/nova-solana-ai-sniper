import { describe, expect, it, vi, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import { fetchMarketContext, formatMarketFacts } from './marketContext.js';

const fakeLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function fakePrisma(count: number | Error): PrismaClient {
  const tokenCount =
    count instanceof Error ? vi.fn().mockRejectedValue(count) : vi.fn().mockResolvedValue(count);
  return { token: { count: tokenCount } } as unknown as PrismaClient;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMarketContext', () => {
  it('returns both figures when DexScreener and the DB both succeed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            pairs: [
              { liquidity: { usd: 1000 }, priceChange: { h24: 2.1 } },
              { liquidity: { usd: 500_000 }, priceChange: { h24: 4.2 } },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const ctx = await fetchMarketContext(fakePrisma(1240), fakeLogger);
    // picks the highest-liquidity pair's priceChange, not the first one
    expect(ctx.solPriceChangePct24h).toBe(4.2);
    expect(ctx.tokensScreened24h).toBe(1240);
  });

  it('omits the SOL figure (never throws) when the DexScreener call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const ctx = await fetchMarketContext(fakePrisma(10), fakeLogger);
    expect(ctx.solPriceChangePct24h).toBeUndefined();
    expect(ctx.tokensScreened24h).toBe(10);
    expect(fakeLogger.warn).toHaveBeenCalled();
  });

  it('omits the SOL figure when DexScreener responds with a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));

    const ctx = await fetchMarketContext(fakePrisma(10), fakeLogger);
    expect(ctx.solPriceChangePct24h).toBeUndefined();
  });

  it('omits the platform figure (never throws) when the DB query fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ pairs: [] }), { status: 200 })),
    );

    const ctx = await fetchMarketContext(fakePrisma(new Error('db down')), fakeLogger);
    expect(ctx.tokensScreened24h).toBeUndefined();
    expect(fakeLogger.warn).toHaveBeenCalled();
  });
});

describe('formatMarketFacts', () => {
  it('returns undefined when neither figure is available', () => {
    expect(formatMarketFacts({})).toBeUndefined();
  });

  it('formats a positive SOL change with an explicit "+" sign', () => {
    expect(formatMarketFacts({ solPriceChangePct24h: 4.2 })).toContain('+4.2%');
  });

  it('formats a negative SOL change without a double sign', () => {
    expect(formatMarketFacts({ solPriceChangePct24h: -3.5 })).toContain('-3.5%');
  });

  it('includes both figures when both are available', () => {
    const text = formatMarketFacts({ solPriceChangePct24h: 1, tokensScreened24h: 500 })!;
    expect(text).toContain('SOL price change');
    expect(text).toContain('500');
  });
});
