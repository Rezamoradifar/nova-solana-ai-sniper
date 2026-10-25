import { describe, expect, it, vi, afterEach } from 'vitest';
import { createGmgnTraderFeed, fetchTraderStats, normalizeTraderStats } from './gmgnTraders.js';
import type { GmgnSmartMoneyTrade } from './gmgn.js';
const first = 'DZAa55HwXgv5hStwaTEJGXZz1DhHejvpb7Yr762urXam';
const second = '7BWy2mtHNdnWLMZejk5E5sfDDSQfXsjzjy9jPzeDyYk5';
const other = 'So11111111111111111111111111111111111111112';
const now = 1_792_885_450_000;
const stats = (address = first, profit: unknown = '2677.7196843771935') => ({
  wallet_address: address,
  realized_profit: profit,
  realized_profit_pnl: '0.0704966892746117',
  buy: 612,
  sell: 166,
  last_timestamp: now / 1000 - 10,
  pnl_stat: { winrate: 0.36054421768707484 },
  common: { name: '', twitter_name: 'ozark' },
});
const trade = (maker = first, amountUsd = 100): GmgnSmartMoneyTrade => ({
  maker,
  transactionHash: maker + 'tx',
  tokenAddress: other,
  tokenSymbol: 'SOL',
  side: 'sell',
  amountUsd,
  timestamp: now / 1000,
  tags: ['smart_degen'],
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('official GMGN wallet performance normalization', () => {
  it('reads the observed official single-wallet shape and converts fractions once', () => {
    const item = normalizeTraderStats(stats(), [first], now).get(first)!;
    expect(item.name).toBe('ozark');
    expect(item.performance.realizedPnlUsd).toBeCloseTo(2677.7196843771935);
    expect(item.performance.roiPct).toBeCloseTo(7.04966892746117);
    expect(item.performance.winRatePct).toBeCloseTo(36.054421768707484);
    expect(item.lastActivityAt).toBe(now - 10_000);
  });
  it('associates batch rows by wallet address, independent of response order', () => {
    const result = normalizeTraderStats(
      { list: [stats(second, '-12.5'), stats(first, '0'), stats(other, 1e6)] },
      [first, second],
      now,
    );
    expect(result.size).toBe(2);
    expect(result.get(first)?.performance.realizedPnlUsd).toBe(0);
    expect(result.get(second)?.performance.realizedPnlUsd).toBe(-12.5);
    expect(result.has(other)).toBe(false);
  });
  it('rejects duplicate/mismatched identities instead of borrowing another wallet profit', () => {
    expect(normalizeTraderStats([stats(), stats(first, 999)], [first], now).size).toBe(0);
    expect(normalizeTraderStats({ [first]: stats(second) }, [first], now).size).toBe(0);
    expect(
      normalizeTraderStats({ [first]: { realized_profit: '12' } }, [first], now).get(first)
        ?.performance.realizedPnlUsd,
    ).toBe(12);
  });
  it('does not invent zero returns, fees, wins or a last-activity time for malformed fields', () => {
    const item = normalizeTraderStats(
      {
        wallet_address: first,
        realized_profit: '',
        realized_profit_pnl: 'Infinity',
        buy: -1,
        sell: 1.5,
        last_timestamp: now / 1000 + 60,
        pnl_stat: { winrate: 70 },
      },
      [first],
      now,
    ).get(first)!;
    expect(item.performance).toEqual({
      realizedPnlUsd: null,
      roiPct: null,
      winRatePct: null,
      buys: null,
      sells: null,
    });
    expect(item.lastActivityAt).toBeNull();
    expect(() => normalizeTraderStats({ code: 403, data: stats() }, [first], now)).toThrow();
  });
  it('uses the fixed official batch analytics endpoint and bounded optional profile reads', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { list: [stats(), stats(second)] } }),
    });
    vi.stubGlobal('fetch', request);
    await fetchTraderStats('private-provider-key', [first, second], '30d');
    const [url, options] = request.mock.calls[0]!;
    expect(url.origin + url.pathname).toBe('https://openapi.gmgn.ai/v1/user/wallet_profits');
    expect(JSON.parse(options.body)).toEqual({
      chain: 'sol',
      period: '30d',
      wallet_addresses: [first, second],
    });
    expect(options.method).toBe('POST');
    expect(url.href).not.toContain('private-provider-key');
    expect(options.headers['X-APIKEY']).toBe('private-provider-key');
    expect(request.mock.calls).toHaveLength(3);
    expect(
      request.mock.calls.every(([target]) => target.origin === 'https://openapi.gmgn.ai'),
    ).toBe(true);
    expect(options.headers['X-Signature']).toBeUndefined();
  });
  it('uses period profit/cost fields instead of all-time totals', () => {
    const item = normalizeTraderStats(
      {
        list: [
          {
            wallet_address: first,
            realized_profit: '20',
            realized_profit_cost: '100',
            total_realized_profit: '999999',
            total_profit: '123456',
          },
        ],
      },
      [first],
      now,
    ).get(first)!;
    expect(item.performance.realizedPnlUsd).toBe(20);
    expect(item.performance.roiPct).toBe(20);
    expect(item.performance.winRatePct).toBeNull();
  });
  it('keeps successful batch profits when optional profile metadata fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) =>
        url.pathname.endsWith('wallet_profits')
          ? {
              ok: true,
              json: async () => ({
                code: 0,
                data: {
                  list: [
                    { wallet_address: first, realized_profit: '25', realized_profit_cost: '100' },
                  ],
                },
              }),
            }
          : { ok: false },
      ),
    );
    const rows = normalizeTraderStats(await fetchTraderStats('key', [first], '7d'), [first], now);
    expect(rows.get(first)?.performance).toMatchObject({
      realizedPnlUsd: 25,
      roiPct: 25,
      winRatePct: null,
    });
  });
});

describe('bounded shared active-trader feed', () => {
  it('sorts measured profit ahead of volume and never calls a volume value profit', async () => {
    const loadStats = vi.fn(async () => [stats(first, -50), stats(second, 10)]);
    const feed = createGmgnTraderFeed({
      now: () => now,
      loadTrades: vi.fn(async () => [trade(first, 50000), trade(second, 100)]),
      loadStats,
    });
    const value = await feed('7d', 'key');
    expect(value.status).toBe('connected');
    expect(value.scope).toBe('active_smart_money_sample');
    expect(value.traders.map((t) => t.address)).toEqual([second, first]);
    expect(value.traders[1]?.performance?.realizedPnlUsd).toBe(-50);
    expect(value.traders[1]?.observedVolumeUsd).toBe(50000);
  });
  it('coalesces concurrent public visitors and keeps the original successful observation time', async () => {
    let clock = now;
    const loadTrades = vi.fn(async () => [trade()]);
    const loadStats = vi.fn(async () => stats());
    const feed = createGmgnTraderFeed({ now: () => clock, loadTrades, loadStats });
    const [one, two] = await Promise.all([feed('7d', 'key'), feed('7d', 'key')]);
    expect(one).toEqual(two);
    clock += 30_000;
    expect((await feed('7d', 'key')).performanceUpdatedAt).toBe(now);
    expect(loadStats).toHaveBeenCalledTimes(1);
    await feed('30d', 'key');
    expect(loadStats).toHaveBeenLastCalledWith('key', [first], '30d');
    expect(loadStats).toHaveBeenCalledTimes(2);
  });
  it('keeps failed/cooldown observations old and conceals provider errors and credentials', async () => {
    let clock = now;
    const loadStats = vi
      .fn()
      .mockResolvedValueOnce(stats())
      .mockRejectedValue(new Error('secret-key/private-url'));
    const feed = createGmgnTraderFeed({
      now: () => clock,
      loadTrades: vi.fn(async () => [trade()]),
      loadStats,
    });
    await feed('7d', 'private-key');
    clock += 65_000;
    const failed = await feed('7d', 'private-key');
    expect(failed.status).toBe('unavailable');
    expect(failed.performanceUpdatedAt).toBe(now);
    expect(failed.traders[0]?.performance?.realizedPnlUsd).toBeCloseTo(2677.7196843771935);
    expect(JSON.stringify(failed)).not.toMatch(/private|secret/);
    clock += 10_000;
    await feed('7d', 'private-key');
    expect(loadStats).toHaveBeenCalledTimes(2);
  });
  it('retains missing profits as null and does not treat an empty stats response as live proof', async () => {
    const feed = createGmgnTraderFeed({
      now: () => now,
      loadTrades: vi.fn(async () => [trade()]),
      loadStats: vi.fn(async () => ({})),
    });
    expect(await feed('7d', 'key')).toMatchObject({
      status: 'partial',
      performanceUpdatedAt: null,
      traders: [{ address: first, performance: null }],
    });
  });
  it('does no provider work without a configured key and deduplicates observed swaps', async () => {
    const loadTrades = vi.fn(async () => [trade(), trade()]);
    const loadStats = vi.fn(async () => stats());
    const feed = createGmgnTraderFeed({ now: () => now, loadTrades, loadStats });
    expect((await feed('7d')).status).toBe('not_configured');
    expect(loadTrades).not.toHaveBeenCalled();
    expect((await feed('7d', 'key')).traders[0]?.observedTrades).toBe(1);
  });
});
