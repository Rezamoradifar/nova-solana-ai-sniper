import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOhlcvWindow, fetchPrimaryPoolAddress, fetchTradeOhlcv } from './geckoTerminal.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function poolsResponse(reserveUsd: string, address = 'PoolAddr1') {
  return {
    ok: true,
    json: async () => ({ data: [{ attributes: { address, reserve_in_usd: reserveUsd } }] }),
  };
}

function ohlcvResponse(rows: number[][]) {
  return {
    ok: true,
    json: async () => ({ data: { attributes: { ohlcv_list: rows } } }),
  };
}

describe('fetchPrimaryPoolAddress', () => {
  it('picks the highest-liquidity pool among several', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { attributes: { address: 'Low', reserve_in_usd: '100' } },
            { attributes: { address: 'High', reserve_in_usd: '50000' } },
          ],
        }),
      }),
    );
    expect(await fetchPrimaryPoolAddress('MintX')).toBe('High');
  });

  it('returns undefined when no pools exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
    );
    expect(await fetchPrimaryPoolAddress('MintX')).toBeUndefined();
  });
});

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

  it('picks 1-minute resolution for a hold time right at the 30-minute boundary, unaffected by padding pushing the total window past it', async () => {
    // Regression guard for the extraction: fetchTradeOhlcv must pick its
    // resolution from the raw hold time, not the padded window (a 24min hold
    // pads out to a ~36min window, which would cross the 30min/5-min-candle
    // threshold if resolution were picked from the padded window instead).
    const buyAtMs = Date.UTC(2026, 6, 28, 10, 0, 0);
    const sellAtMs = buyAtMs + 24 * 60_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(poolsResponse('1000'))
      .mockResolvedValueOnce(ohlcvResponse([[Math.floor(sellAtMs / 1000), 1, 1, 1, 1, 1]]));
    vi.stubGlobal('fetch', fetchMock);

    await fetchTradeOhlcv('MintX', buyAtMs, sellAtMs);

    const [ohlcvUrl] = fetchMock.mock.calls[1]!;
    expect(ohlcvUrl).toContain('/ohlcv/minute');
    expect(ohlcvUrl).toContain('aggregate=1');
  });
});

describe('fetchOhlcvWindow', () => {
  it('picks resolution from the window span itself and returns real candles', async () => {
    const start = Date.UTC(2026, 6, 28, 10, 0, 0);
    const end = start + 45 * 60_000; // > 30min -> 5-minute aggregate
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(poolsResponse('1000'))
      .mockResolvedValueOnce(ohlcvResponse([[Math.floor(end / 1000), 1, 1.1, 0.9, 1, 1]]));
    vi.stubGlobal('fetch', fetchMock);

    const candles = await fetchOhlcvWindow('MintX', start, end);

    expect(candles).toHaveLength(1);
    const [ohlcvUrl] = fetchMock.mock.calls[1]!;
    expect(ohlcvUrl).toContain('/ohlcv/minute');
    expect(ohlcvUrl).toContain('aggregate=5');
  });

  it('returns undefined when no pool is found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
    );
    expect(await fetchOhlcvWindow('MintX', Date.now() - 60_000, Date.now())).toBeUndefined();
  });
});
