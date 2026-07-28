import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTradePriceChartSvg,
  fetchTradeOhlcv,
  resolveRealPriceChartPhoto,
  type Candle,
} from './priceChart.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function poolsResponse(reserveUsd: string) {
  return {
    ok: true,
    json: async () => ({
      data: [{ attributes: { address: 'PoolAddr1', reserve_in_usd: reserveUsd } }],
    }),
  };
}

function ohlcvResponse(rows: number[][]) {
  return {
    ok: true,
    json: async () => ({ data: { attributes: { ohlcv_list: rows } } }),
  };
}

describe('fetchTradeOhlcv', () => {
  it('picks the highest-liquidity pool and returns ascending real candles', async () => {
    const buyAtMs = Date.UTC(2026, 6, 28, 10, 0, 0);
    const sellAtMs = Date.UTC(2026, 6, 28, 10, 20, 0);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { attributes: { address: 'LowLiquidityPool', reserve_in_usd: '100' } },
            { attributes: { address: 'HighLiquidityPool', reserve_in_usd: '50000' } },
          ],
        }),
      })
      .mockResolvedValueOnce(
        ohlcvResponse([
          [Math.floor(sellAtMs / 1000), 0.002, 0.0021, 0.0019, 0.002, 100],
          [Math.floor(buyAtMs / 1000), 0.001, 0.0011, 0.0009, 0.001, 100],
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const candles = await fetchTradeOhlcv('MintX', buyAtMs, sellAtMs);

    expect(candles).toHaveLength(2);
    expect(candles![0]!.tMs).toBeLessThan(candles![1]!.tMs);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('HighLiquidityPool'),
      expect.anything(),
    );
  });

  it('returns undefined when no pool is found for the mint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
    );
    expect(await fetchTradeOhlcv('MintX', Date.now() - 60_000, Date.now())).toBeUndefined();
  });

  it('returns undefined on a non-2xx response rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    expect(await fetchTradeOhlcv('MintX', Date.now() - 60_000, Date.now())).toBeUndefined();
  });

  it('returns undefined on a network error rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    expect(await fetchTradeOhlcv('MintX', Date.now() - 60_000, Date.now())).toBeUndefined();
  });

  it('returns undefined when the pool lookup succeeds but ohlcv_list is empty', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(poolsResponse('1000'))
      .mockResolvedValueOnce(ohlcvResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchTradeOhlcv('MintX', Date.now() - 60_000, Date.now())).toBeUndefined();
  });
});

describe('buildTradePriceChartSvg', () => {
  const candles: Candle[] = [
    { tMs: Date.UTC(2026, 6, 28, 9, 55), open: 0.0009, high: 0.001, low: 0.0008, close: 0.00095 },
    { tMs: Date.UTC(2026, 6, 28, 10, 0), open: 0.00095, high: 0.0011, low: 0.0009, close: 0.001 },
    { tMs: Date.UTC(2026, 6, 28, 10, 20), open: 0.001, high: 0.0022, low: 0.001, close: 0.002 },
    { tMs: Date.UTC(2026, 6, 28, 10, 25), open: 0.002, high: 0.0021, low: 0.0018, close: 0.0019 },
  ];

  it('renders a real-data chart with distinct BUY and SELL markers, never mentioning a logo', () => {
    const svg = buildTradePriceChartSvg({
      candles,
      buyAtMs: Date.UTC(2026, 6, 28, 10, 0),
      buyPriceUsd: 0.001,
      sellAtMs: Date.UTC(2026, 6, 28, 10, 20),
      sellPriceUsd: 0.002,
      tokenLabel: '$EXT',
      isProfit: true,
    });

    expect(svg).toContain('<svg');
    expect(svg).toContain('BUY');
    expect(svg).toContain('SELL');
    expect(svg).toContain('EXT');
    expect(svg.toLowerCase()).not.toContain('logo');
    // A polyline connecting every real close price is present.
    expect(svg).toMatch(/<polyline points="[\d.,\s]+"/);
  });

  it('colors the chart red for a loss and green for a profit', () => {
    const lossSvg = buildTradePriceChartSvg({
      candles,
      buyAtMs: Date.UTC(2026, 6, 28, 10, 0),
      buyPriceUsd: 0.001,
      sellAtMs: Date.UTC(2026, 6, 28, 10, 20),
      sellPriceUsd: 0.0005,
      tokenLabel: '$EXT',
      isProfit: false,
    });
    const profitSvg = buildTradePriceChartSvg({
      candles,
      buyAtMs: Date.UTC(2026, 6, 28, 10, 0),
      buyPriceUsd: 0.001,
      sellAtMs: Date.UTC(2026, 6, 28, 10, 20),
      sellPriceUsd: 0.002,
      tokenLabel: '$EXT',
      isProfit: true,
    });

    expect(lossSvg).toContain('#f5433c');
    expect(profitSvg).toContain('#22d97a');
  });

  it('never throws on a single-candle or degenerate price/time range', () => {
    const flat: Candle[] = [{ tMs: 1000, open: 1, high: 1, low: 1, close: 1 }];
    expect(() =>
      buildTradePriceChartSvg({
        candles: flat,
        buyAtMs: 1000,
        buyPriceUsd: 1,
        sellAtMs: 1000,
        sellPriceUsd: 1,
        tokenLabel: '$FLAT',
        isProfit: true,
      }),
    ).not.toThrow();
  });

  it('handles an empty candle array by falling back to the buy/sell points alone', () => {
    expect(() =>
      buildTradePriceChartSvg({
        candles: [],
        buyAtMs: Date.UTC(2026, 6, 28, 10, 0),
        buyPriceUsd: 0.001,
        sellAtMs: Date.UTC(2026, 6, 28, 10, 20),
        sellPriceUsd: 0.002,
        tokenLabel: '$EXT',
        isProfit: true,
      }),
    ).not.toThrow();
  });
});

describe('resolveRealPriceChartPhoto', () => {
  const baseTrade = {
    mint: 'MintX',
    tokenName: 'Example Token',
    tokenSymbol: 'EXT',
    buyAt: new Date('2026-07-28T10:00:00Z'),
    sellAt: new Date('2026-07-28T10:20:00Z'),
    entryPriceUsd: 0.001,
    exitPriceUsd: 0.002,
    roiPercent: 50,
  };

  it('returns a real PNG buffer when OHLCV data is available', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(poolsResponse('1000'))
      .mockResolvedValueOnce(
        ohlcvResponse([
          [Math.floor(baseTrade.sellAt.getTime() / 1000), 0.002, 0.0021, 0.0019, 0.002, 10],
          [Math.floor(baseTrade.buyAt.getTime() / 1000), 0.001, 0.0011, 0.0009, 0.001, 10],
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveRealPriceChartPhoto(baseTrade);

    expect(result).toBeDefined();
    expect(result!.buffer.length).toBeGreaterThan(0);
    // A PNG file signature — proof this is a real rendered image, not a stub.
    expect(result!.buffer.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('falls back to the last candle close when exitPriceUsd is unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(poolsResponse('1000'))
      .mockResolvedValueOnce(
        ohlcvResponse([
          [Math.floor(baseTrade.sellAt.getTime() / 1000), 0.002, 0.0021, 0.0019, 0.0022, 10],
          [Math.floor(baseTrade.buyAt.getTime() / 1000), 0.001, 0.0011, 0.0009, 0.001, 10],
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveRealPriceChartPhoto({ ...baseTrade, exitPriceUsd: undefined });
    expect(result).toBeDefined();
  });

  it('returns undefined (never a logo, never a placeholder) when no pool/candles are found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
    );
    expect(await resolveRealPriceChartPhoto(baseTrade)).toBeUndefined();
  });
});
