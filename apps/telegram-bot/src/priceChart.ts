import sharp from 'sharp';
import { escapeXml } from './cards/render.js';

/**
 * Real-data price chart for a completed trade (2026-07-28 fix).
 *
 * Background: the "REAL BOT TRADE" notification was falling back to the
 * token *logo* as its photo far more often than intended. The intended tier-1
 * source — scraping DexScreener's own og:image chart-preview off the token
 * page (see tradeNotification.ts's fetchDexScreenerChartImage) — turns out to
 * be permanently blocked from this server: both DexScreener's HTML page and
 * its undocumented internal chart-candle API (io.dexscreener.com) return a
 * Cloudflare "Just a moment..." challenge, confirmed with both a plain fetch
 * and a full headless Chromium (Puppeteer) that never resolves the challenge
 * after 30+ seconds. A server-side screenshot of DexScreener's page is
 * therefore not viable from this box — it's an IP-level block, not a scraping
 * bug fixable in this codebase.
 *
 * This module is the replacement fallback: render our own real-data price
 * chart from GeckoTerminal's public OHLCV API (unauthenticated, not
 * Cloudflare-blocked — verified working), using the same sharp/SVG rendering
 * technique already proven in this package (see cards/render.ts). The Buy and
 * Sell markers are plotted at the bot's own real recorded fill price/time,
 * which is more accurate than anything a DexScreener screenshot could show
 * anyway (DexScreener has no notion of *our* fills).
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
async function fetchPrimaryPoolAddress(mint: string): Promise<string | undefined> {
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

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Coarser candles for a longer hold — keeps the fetched window at a sane
 * candle count instead of asking for e.g. months of 1-minute candles. */
function pickResolution(holdMs: number): Resolution {
  if (holdMs <= 30 * MINUTE_MS) return { timeframe: 'minute', aggregate: 1, intervalMs: MINUTE_MS };
  if (holdMs <= 6 * HOUR_MS)
    return { timeframe: 'minute', aggregate: 5, intervalMs: 5 * MINUTE_MS };
  if (holdMs <= 2 * DAY_MS) return { timeframe: 'hour', aggregate: 1, intervalMs: HOUR_MS };
  if (holdMs <= 14 * DAY_MS) return { timeframe: 'hour', aggregate: 4, intervalMs: 4 * HOUR_MS };
  return { timeframe: 'day', aggregate: 1, intervalMs: DAY_MS };
}

interface GeckoTerminalOhlcvResponse {
  data?: { attributes?: { ohlcv_list?: number[][] } };
}

/**
 * Real per-trade OHLCV window from GeckoTerminal, padded ~25% of the hold
 * time on each side (minimum two candle intervals) so the rendered chart
 * shows context before the buy and after the sell, not just the two points.
 * Never throws — any lookup/fetch failure (no pool found, rate-limited,
 * network error, empty response) resolves to undefined, same "best-effort
 * enrichment" convention as fetchDexScreenerChartImage.
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
  } catch {
    return undefined;
  }
}

// --- Rendering ---------------------------------------------------------------

const CHART_WIDTH = 1080;
const CHART_HEIGHT = 640;
const PAD_LEFT = 138;
const PAD_RIGHT = 40;
const PAD_TOP = 96;
const PAD_BOTTOM = 60;

/** Keeps a marker's label box fully on-canvas even when its point sits right
 * at the time-axis edge (a Buy/Sell at the very start/end of the fetched
 * window, which is common — the window is only padded ~25% past each leg). */
function clampLabelCenterX(centerX: number, halfWidth: number): number {
  const min = PAD_LEFT + halfWidth;
  const max = CHART_WIDTH - PAD_RIGHT - halfWidth;
  return Math.min(Math.max(centerX, min), max);
}

export interface TradeChartInput {
  candles: Candle[];
  buyAtMs: number;
  buyPriceUsd: number;
  sellAtMs: number;
  sellPriceUsd: number;
  tokenLabel: string;
  isProfit: boolean;
}

function fmtAxisPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
}

function fmtAxisTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Builds the SVG markup for one trade's price chart — a filled line chart of
 * real close prices (not a candlestick chart: at 1-minute resolution a filled
 * line reads far more cleanly at Telegram photo size, and every value plotted
 * is still a real, unmodified close price from fetchTradeOhlcv). Exported
 * separately from the PNG render so tests can assert on the markup without
 * needing sharp/librsvg. */
export function buildTradePriceChartSvg(input: TradeChartInput): string {
  const { candles } = input;
  const safeCandles =
    candles.length > 0
      ? candles
      : [
          {
            tMs: input.buyAtMs,
            open: input.buyPriceUsd,
            high: input.buyPriceUsd,
            low: input.buyPriceUsd,
            close: input.buyPriceUsd,
          },
          {
            tMs: input.sellAtMs,
            open: input.sellPriceUsd,
            high: input.sellPriceUsd,
            low: input.sellPriceUsd,
            close: input.sellPriceUsd,
          },
        ];

  const times = [...safeCandles.map((c) => c.tMs), input.buyAtMs, input.sellAtMs];
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const timeSpread = maxT - minT || MINUTE_MS;

  const prices = [
    ...safeCandles.flatMap((c) => [c.high, c.low]),
    input.buyPriceUsd,
    input.sellPriceUsd,
  ];
  const minPRaw = Math.min(...prices);
  const maxPRaw = Math.max(...prices);
  const priceSpreadRaw = maxPRaw - minPRaw;
  const priceSpread = priceSpreadRaw > 0 ? priceSpreadRaw : maxPRaw * 0.1 || 1;
  // A token price can never be negative — clamp the padded floor at zero
  // rather than letting the y-axis show a nonsensical negative price.
  const minP = Math.max(minPRaw - priceSpread * 0.1, 0);
  const maxP = maxPRaw + priceSpread * 0.1;
  const priceRange = maxP - minP || 1;

  const innerW = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

  const x = (t: number) => PAD_LEFT + ((t - minT) / timeSpread) * innerW;
  const y = (p: number) => PAD_TOP + (1 - (p - minP) / priceRange) * innerH;

  const points = safeCandles.map((c) => ({ x: x(c.tMs), y: y(c.close) }));
  const linePoints = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const floorY = (PAD_TOP + innerH).toFixed(1);
  const areaPath =
    `M ${points[0]!.x.toFixed(1)},${floorY} ` +
    `L ${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')} ` +
    `L ${points.at(-1)!.x.toFixed(1)},${floorY} Z`;

  const lineColor = input.isProfit ? '#22d97a' : '#f5433c';
  const areaTop = input.isProfit ? 'rgba(34,217,122,0.35)' : 'rgba(245,67,60,0.35)';
  const areaBottom = input.isProfit ? 'rgba(34,217,122,0)' : 'rgba(245,67,60,0)';

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const gy = PAD_TOP + f * innerH;
      const price = maxP - f * priceRange;
      return (
        `<line x1="${PAD_LEFT}" y1="${gy.toFixed(1)}" x2="${CHART_WIDTH - PAD_RIGHT}" y2="${gy.toFixed(1)}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>` +
        `<text x="${PAD_LEFT - 12}" y="${(gy + 5).toFixed(1)}" text-anchor="end" font-family="Arial, sans-serif" font-size="18" fill="#8992a8">${escapeXml(fmtAxisPrice(price))}</text>`
      );
    })
    .join('');

  const buyX = x(input.buyAtMs);
  const buyY = y(input.buyPriceUsd);
  const sellX = x(input.sellAtMs);
  const sellY = y(input.sellPriceUsd);
  const sellColor = input.isProfit ? '#22d97a' : '#f5433c';

  const buyLabelHalfWidth = 60;
  const buyLabelX = clampLabelCenterX(buyX, buyLabelHalfWidth);
  const buyMarker = `
    <line x1="${buyX.toFixed(1)}" y1="${PAD_TOP}" x2="${buyX.toFixed(1)}" y2="${floorY}" stroke="#22d97a" stroke-width="1.5" stroke-dasharray="4,4" opacity="0.7"/>
    <circle cx="${buyX.toFixed(1)}" cy="${buyY.toFixed(1)}" r="8" fill="#0a0c14" stroke="#22d97a" stroke-width="3"/>
    <rect x="${(buyLabelX - buyLabelHalfWidth).toFixed(1)}" y="${(PAD_TOP - 34).toFixed(1)}" width="${buyLabelHalfWidth * 2}" height="30" rx="8" fill="#22d97a"/>
    <text x="${buyLabelX.toFixed(1)}" y="${(PAD_TOP - 13).toFixed(1)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="17" font-weight="700" fill="#06110a">BUY ${escapeXml(fmtAxisPrice(input.buyPriceUsd))}</text>`;

  const sellLabelHalfWidth = 66;
  const sellLabelX = clampLabelCenterX(sellX, sellLabelHalfWidth);
  const sellMarker = `
    <line x1="${sellX.toFixed(1)}" y1="${PAD_TOP}" x2="${sellX.toFixed(1)}" y2="${floorY}" stroke="${sellColor}" stroke-width="1.5" stroke-dasharray="4,4" opacity="0.7"/>
    <circle cx="${sellX.toFixed(1)}" cy="${sellY.toFixed(1)}" r="8" fill="#0a0c14" stroke="${sellColor}" stroke-width="3"/>
    <rect x="${(sellLabelX - sellLabelHalfWidth).toFixed(1)}" y="${(PAD_TOP - 34).toFixed(1)}" width="${sellLabelHalfWidth * 2}" height="30" rx="8" fill="${sellColor}"/>
    <text x="${sellLabelX.toFixed(1)}" y="${(PAD_TOP - 13).toFixed(1)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="17" font-weight="700" fill="#06110a">SELL ${escapeXml(fmtAxisPrice(input.sellPriceUsd))}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0f111c"/>
      <stop offset="100%" stop-color="#0a0c14"/>
    </linearGradient>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${areaTop}"/>
      <stop offset="100%" stop-color="${areaBottom}"/>
    </linearGradient>
  </defs>
  <rect width="${CHART_WIDTH}" height="${CHART_HEIGHT}" fill="url(#bg)"/>
  <text x="40" y="46" font-family="Arial, sans-serif" font-size="28" font-weight="800" fill="#f0f2f8">${escapeXml(input.tokenLabel)} · PRICE CHART</text>
  <text x="40" y="72" font-family="Arial, sans-serif" font-size="17" fill="#5b6478">Real market data</text>
  <text x="${CHART_WIDTH - 40}" y="46" text-anchor="end" font-family="Arial, sans-serif" font-size="17" fill="#5b6478">${escapeXml(fmtAxisTime(minT))} – ${escapeXml(fmtAxisTime(maxT))} UTC</text>
  ${gridLines}
  <path d="${areaPath}" fill="url(#area)"/>
  <polyline points="${linePoints}" fill="none" stroke="${lineColor}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
  ${buyMarker}
  ${sellMarker}
  <text x="${CHART_WIDTH / 2}" y="${CHART_HEIGHT - 22}" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" letter-spacing="2" fill="#5b6478">NOVA SNIPER AI</text>
</svg>`;
}

export async function renderTradePriceChartPng(input: TradeChartInput): Promise<Buffer> {
  return sharp(Buffer.from(buildTradePriceChartSvg(input)))
    .png()
    .toBuffer();
}

export interface TradeChartTrade {
  mint: string;
  tokenName: string | undefined;
  tokenSymbol: string | undefined;
  buyAt: Date;
  sellAt: Date;
  entryPriceUsd: number;
  exitPriceUsd: number | undefined;
  roiPercent: number;
}

/**
 * Single entry point: fetches real OHLCV for the trade's window and renders
 * the annotated chart PNG. Never throws — any failure along the way (no
 * pool found, GeckoTerminal rate-limited/unreachable, render error) resolves
 * to undefined so the caller can degrade (never to the token logo — see this
 * module's own doc comment on why that tier was removed).
 */
export async function resolveRealPriceChartPhoto(
  trade: TradeChartTrade,
): Promise<{ buffer: Buffer } | undefined> {
  try {
    const candles = await fetchTradeOhlcv(
      trade.mint,
      trade.buyAt.getTime(),
      trade.sellAt.getTime(),
    );
    if (!candles || candles.length === 0) return undefined;

    const sellPriceUsd = trade.exitPriceUsd ?? candles.at(-1)!.close;
    const tokenLabel = trade.tokenSymbol
      ? `$${trade.tokenSymbol}`
      : (trade.tokenName ?? `${trade.mint.slice(0, 4)}…${trade.mint.slice(-4)}`);

    const buffer = await renderTradePriceChartPng({
      candles,
      buyAtMs: trade.buyAt.getTime(),
      buyPriceUsd: trade.entryPriceUsd,
      sellAtMs: trade.sellAt.getTime(),
      sellPriceUsd,
      tokenLabel,
      isProfit: trade.roiPercent >= 0,
    });
    return { buffer };
  } catch {
    return undefined;
  }
}
