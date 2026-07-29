/**
 * Real Solana market data from GeckoTerminal's public OHLCV API
 * (unauthenticated, confirmed NOT Cloudflare-blocked from this server —
 * unlike DexScreener itself, whose page and undocumented internal chart-candle
 * API are both blocked behind a Cloudflare challenge that not even a full
 * headless-Chromium screenshot attempt resolves; see
 * apps/telegram-bot/src/priceChart.ts's own doc comment for that
 * investigation). Extracted here (2026-07-28) so both the Telegram trade-chart
 * feature and the backtest engine (apps/api/src/trading) share one real,
 * already-verified data source instead of duplicating the GeckoTerminal
 * integration.
 */

const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2';
const FETCH_TIMEOUT_MS = 8_000;

async function fetchJson(url: string): Promise<unknown | undefined> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

interface GeckoTerminalPoolsResponse {
  data?: Array<{ attributes?: { address?: string; reserve_in_usd?: string } }>;
}

/**
 * Picks the Solana pool with the most on-chain liquidity for this mint — same
 * "most representative price" convention DexScreener/most trackers use when a
 * token trades across several pools (e.g. a pump.fun bonding-curve pool and a
 * post-migration Raydium/PumpSwap pool for the same mint).
 */
export async function fetchPrimaryPoolAddress(mint: string): Promise<string | undefined> {
  const json = (await fetchJson(`${GECKOTERMINAL_BASE}/networks/solana/tokens/${mint}/pools`)) as
    GeckoTerminalPoolsResponse | undefined;
  const pools = json?.data;
  if (!pools || pools.length === 0) return undefined;

  let best: { address: string; reserveUsd: number } | undefined;
  for (const pool of pools) {
    const address = pool.attributes?.address;
    const reserveUsd = Number(pool.attributes?.reserve_in_usd ?? 0);
    if (!address) continue;
    if (!best || reserveUsd > best.reserveUsd) best = { address, reserveUsd };
  }
  return best?.address;
}

export interface Candle {
  tMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Resolution {
  timeframe: 'minute' | 'hour' | 'day';
  aggregate: number;
  intervalMs: number;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Coarser candles for a longer window — keeps the fetched candle count sane
 * instead of asking for e.g. months of 1-minute candles. */
function pickResolution(windowMs: number): Resolution {
  if (windowMs <= 30 * MINUTE_MS)
    return { timeframe: 'minute', aggregate: 1, intervalMs: MINUTE_MS };
  if (windowMs <= 6 * HOUR_MS)
    return { timeframe: 'minute', aggregate: 5, intervalMs: 5 * MINUTE_MS };
  if (windowMs <= 2 * DAY_MS) return { timeframe: 'hour', aggregate: 1, intervalMs: HOUR_MS };
  if (windowMs <= 14 * DAY_MS) return { timeframe: 'hour', aggregate: 4, intervalMs: 4 * HOUR_MS };
  return { timeframe: 'day', aggregate: 1, intervalMs: DAY_MS };
}

interface GeckoTerminalOhlcvResponse {
  data?: { attributes?: { ohlcv_list?: number[][] } };
}

/** Low-level fetch+parse against an already-resolved pool, given an
 * already-chosen resolution/limit/end-timestamp. Never throws. Shared by
 * both fetchOhlcvWindow and fetchTradeOhlcv so the two only differ in how
 * they pick `resolution`/`limit`/`beforeTimestampSec`, not in the actual API
 * call or response parsing. */
async function fetchCandlesForPool(
  poolAddress: string,
  resolution: Resolution,
  beforeTimestampSec: number,
  limit: number,
): Promise<Candle[] | undefined> {
  const json = (await fetchJson(
    `${GECKOTERMINAL_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${resolution.timeframe}` +
      `?aggregate=${resolution.aggregate}&before_timestamp=${beforeTimestampSec}&limit=${limit}&currency=usd`,
  )) as GeckoTerminalOhlcvResponse | undefined;
  const rows = json?.data?.attributes?.ohlcv_list;
  if (!rows || rows.length === 0) return undefined;

  return rows
    .filter((row): row is [number, number, number, number, number, number] => row.length >= 5)
    .map(([t, o, h, l, c]) => ({ tMs: t * 1000, open: o, high: h, low: l, close: c }))
    .sort((a, b) => a.tMs - b.tMs);
}

/**
 * Real OHLCV candles for a mint's highest-liquidity Solana pool, covering
 * [windowStartMs, windowEndMs] — resolution picked from the window's own
 * total span. General-purpose primitive (used by the backtest engine, which
 * has its own, independently-computed windows); fetchTradeOhlcv below is a
 * distinct, narrower wrapper and does not delegate to this, since its
 * resolution choice is deliberately based on the raw hold time, not the
 * padded window (see its own doc comment). Never throws — any lookup/fetch
 * failure (no pool found, rate-limited, network error, empty response)
 * resolves to undefined, same "best-effort real-data lookup" convention used
 * throughout this codebase.
 */
export async function fetchOhlcvWindow(
  mint: string,
  windowStartMs: number,
  windowEndMs: number,
): Promise<Candle[] | undefined> {
  try {
    const poolAddress = await fetchPrimaryPoolAddress(mint);
    if (!poolAddress) return undefined;

    const windowMs = Math.max(windowEndMs - windowStartMs, 0);
    const resolution = pickResolution(windowMs);
    const candleCount = Math.ceil(windowMs / resolution.intervalMs) + 4;
    const limit = Math.min(Math.max(candleCount, 20), 1000);
    const beforeTimestampSec = Math.ceil(windowEndMs / 1000);

    return await fetchCandlesForPool(poolAddress, resolution, beforeTimestampSec, limit);
  } catch {
    return undefined;
  }
}

/**
 * Real per-trade OHLCV window, padded ~25% of the hold time on each side
 * (minimum two candle intervals) so a rendered chart has context before the
 * buy and after the sell, not just the two points themselves. Deliberately
 * picks its candle resolution from the raw hold time (buyAtMs..sellAtMs),
 * not from the padded window — byte-identical behavior to this module's
 * pre-extraction form, and the right choice for "how granular should this
 * trade's own price action look," independent of how much context padding
 * happens to add around it.
 */
export async function fetchTradeOhlcv(
  mint: string,
  buyAtMs: number,
  sellAtMs: number,
): Promise<Candle[] | undefined> {
  try {
    const poolAddress = await fetchPrimaryPoolAddress(mint);
    if (!poolAddress) return undefined;

    const holdMs = Math.max(sellAtMs - buyAtMs, 0);
    const resolution = pickResolution(holdMs);
    const padMs = Math.max(holdMs * 0.25, resolution.intervalMs * 2);
    const windowStartMs = buyAtMs - padMs;
    const windowEndMs = sellAtMs + padMs;
    const candleCount = Math.ceil((windowEndMs - windowStartMs) / resolution.intervalMs) + 4;
    const limit = Math.min(Math.max(candleCount, 20), 1000);
    const beforeTimestampSec = Math.ceil(windowEndMs / 1000);

    return await fetchCandlesForPool(poolAddress, resolution, beforeTimestampSec, limit);
  } catch {
    return undefined;
  }
}
