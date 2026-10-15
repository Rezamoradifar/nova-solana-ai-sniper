import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGmgnMarketFeed, normalizeGmgnTrending } from './gmgnMarket.js';
const token = {
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
  name: 'Solana',
  price: '150.12',
  volume: '700',
  liquidity: '900',
  smart_degen_count: 3,
};
afterEach(() => {
  vi.restoreAllMocks();
});
describe('GMGN market integration', () => {
  it('normalizes documented rank fields and strips unapproved metadata', () => {
    expect(normalizeGmgnTrending({ rank: [{ ...token, apiKey: 'secret' }] })).toEqual([
      {
        address: token.address,
        symbol: 'SOL',
        name: 'Solana',
        priceUsd: 150.12,
        volumeUsd: 700,
        liquidityUsd: 900,
        smartMoneyHolders: 3,
      },
    ]);
    expect(
      normalizeGmgnTrending({
        rank: [
          { ...token, price: 'NaN' },
          { ...token, address: 'javascript:alert(1)' },
          { ...token, price: '-5' },
        ],
      }),
    ).toEqual([]);
    expect(() => normalizeGmgnTrending({ data: { rank: [] } })).toThrow();
  });
  it('accepts the successful CLI envelope observed on the production server', () => {
    expect(normalizeGmgnTrending({ code: 0, data: { rank: [token] }, message: 'success' })).toEqual(
      normalizeGmgnTrending({ rank: [token] }),
    );
  });
  it('rejects error envelopes even when they contain plausible rank data', () => {
    expect(() => normalizeGmgnTrending({ code: 403, data: { rank: [token] } })).toThrow();
    expect(() => normalizeGmgnTrending({ code: 0, data: {} })).toThrow();
  });
  it('connects the website feed with enveloped CLI output', async () => {
    const read = createGmgnMarketFeed(async () => ({ code: 0, data: { rank: [token] } }));
    const result = await read('test-key');
    expect(result.status).toBe('connected');
    expect(result.tokens[0]).toMatchObject({ symbol: 'SOL', priceUsd: 150.12 });
  });
  it('does not run the CLI when a key is absent', async () => {
    const run = vi.fn();
    expect(await createGmgnMarketFeed(run)()).toMatchObject({
      status: 'not_configured',
      tokens: [],
    });
    expect(run).not.toHaveBeenCalled();
  });
  it('shares requests and cached results among visitors', async () => {
    const run = vi.fn().mockResolvedValue({ rank: [token] });
    const read = createGmgnMarketFeed(run);
    const results = await Promise.all([read('secret'), read('secret'), read('secret')]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ status: 'connected' });
    expect(await read('secret')).toEqual(results[0]);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('keeps original snapshot age on failure and stops retries during cooldown', async () => {
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ rank: [token] })
      .mockRejectedValue(new Error('credentials secret + provider stderr'));
    const read = createGmgnMarketFeed(run);
    await read('secret');
    now += 15_000;
    const result = await read('secret');
    expect(result).toMatchObject({ status: 'unavailable', updatedAt: 100_000, retryAt: 415_000 });
    expect(JSON.stringify(result)).not.toContain('secret');
    await read('secret');
    expect(run).toHaveBeenCalledTimes(2);
    now = 415_001;
    await read('secret');
    expect(run).toHaveBeenCalledTimes(3);
  });
});
