import { InputFile, type Bot } from 'grammy';
import { escapeMd, fmtDate, fmtHoldingTimeShort, pnlEmoji, shortKey, usd } from './ui/format.js';
import { resolveRealPriceChartPhoto } from './priceChart.js';

/**
 * Real Bot Trade notification (2026-07-28) — the one shared shape/builder for
 * "an identical sendPhoto notification for a completed real trade," used by
 * both apps/marketing-engine's TradeShowcaseMonitor (real trades, channel +
 * every subscribed user's DM) and apps/telegram-bot's own /testtrade command
 * (see admin/commands.ts). Lives here rather than in marketing-engine because
 * marketing-engine already depends on this package for its Telegram-format
 * primitives (escapeMd/usd/etc, see lib.ts) — the reverse dependency would be
 * circular. Deliberately decoupled from marketing-engine's Prisma-backed
 * ShowcaseTrade type: this package has no Prisma dependency, so this is a
 * plain, structurally-compatible shape marketing-engine can pass its own
 * ShowcaseTrade + DexScreenerEnrichment fields into with no conversion step.
 */
export interface TradeNotificationData {
  mint: string;
  tokenName: string | undefined;
  tokenSymbol: string | undefined;
  dex: string;
  buyAt: Date;
  sellAt: Date;
  roiPercent: number;
  pnlUsd: number;
  aiScore: number | undefined;
  buySignature: string | undefined;
  sellSignature: string | undefined;
  liquidityUsd: number | undefined;
  marketCapUsd: number | undefined;
  volume24hUsd: number | undefined;
  /** The real fill price at each leg — needed to plot the Buy/Sell markers on
   * the real-data price chart (see resolveTradePhoto below). Not otherwise
   * used in the caption text (ROI/PnL already cover that). */
  entryPriceUsd: number;
  exitPriceUsd: number | undefined;
}

export function solscanTxUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

export function solscanTokenUrl(mint: string): string {
  return `https://solscan.io/token/${mint}`;
}

export function dexscreenerChartUrl(mint: string): string {
  return `https://dexscreener.com/solana/${mint}`;
}

const NOT_AVAILABLE = 'N/A';

function usdOrNa(n: number | undefined): string {
  return n === undefined ? NOT_AVAILABLE : usd(n);
}

/** Telegram's hard cap on a photo caption (UTF-16 code units) — sendPhoto
 * rejects a longer caption outright, so this is enforced here rather than
 * left to fail at send time. */
const PHOTO_CAPTION_LIMIT = 1024;

/**
 * Every field the 2026-07-28 "Real Bot Trade" spec requires, always present
 * as its own line — a value that couldn't be resolved (aiScore, tx
 * signature, enrichment) renders as a literal "N/A" rather than being
 * omitted, same "honest, never fabricated" convention as the rest of this
 * codebase's Telegram formatting, just spelled out per-field instead of
 * per-message.
 */
export function formatTradePhotoCaption(trade: TradeNotificationData): string {
  const label = trade.tokenSymbol
    ? escapeMd(trade.tokenSymbol)
    : trade.tokenName
      ? escapeMd(trade.tokenName)
      : shortKey(trade.mint);
  const holdingMs = trade.sellAt.getTime() - trade.buyAt.getTime();
  const roiStr = `${trade.roiPercent >= 0 ? '+' : ''}${trade.roiPercent.toFixed(1)}%`;

  const lines = [
    `🤖 *REAL BOT TRADE*`,
    '',
    `${pnlEmoji(trade.pnlUsd)} *${label}*`,
    '',
    `Name: ${trade.tokenName ? escapeMd(trade.tokenName) : '(unknown)'}`,
    `Token: \`${escapeMd(trade.mint)}\` ([Solscan](${solscanTokenUrl(trade.mint)}))`,
    `DEX: ${escapeMd(trade.dex)}`,
    `Buy: ${fmtDate(trade.buyAt)} UTC`,
    `Sell: ${fmtDate(trade.sellAt)} UTC`,
    `Hold: ${fmtHoldingTimeShort(holdingMs)}`,
    `ROI: *${roiStr}*`,
    `PnL: *${usd(trade.pnlUsd)}*`,
    `AI Score: *${trade.aiScore !== undefined ? `${Math.round(trade.aiScore)}/100` : NOT_AVAILABLE}*`,
    `Liquidity: ${usdOrNa(trade.liquidityUsd)}`,
    `Market Cap: ${usdOrNa(trade.marketCapUsd)}`,
    `24h Volume: ${usdOrNa(trade.volume24hUsd)}`,
    trade.buySignature
      ? `[Buy TX](${solscanTxUrl(trade.buySignature)})`
      : `Buy TX: ${NOT_AVAILABLE}`,
    trade.sellSignature
      ? `[Sell TX](${solscanTxUrl(trade.sellSignature)})`
      : `Sell TX: ${NOT_AVAILABLE}`,
    `[View on DexScreener](${dexscreenerChartUrl(trade.mint)})`,
    '',
    `🔷 *GSP Bank Sniper*`,
  ];

  const text = lines.join('\n');
  if (text.length <= PHOTO_CAPTION_LIMIT) return text;

  // Truncates the body only — the DexScreener link and brand footer (the two
  // things a shortened caption must never lose) are always appended intact.
  const footer = `\n…\n[View on DexScreener](${dexscreenerChartUrl(trade.mint)})\n\n🔷 *GSP Bank Sniper*`;
  return `${text.slice(0, Math.max(0, PHOTO_CAPTION_LIMIT - footer.length))}${footer}`;
}

export interface ResolvedTradePhoto {
  buffer: Buffer;
}

const IMAGE_FETCH_TIMEOUT_MS = 6_000;

async function downloadImage(url: string): Promise<ResolvedTradePhoto | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) return undefined;
    return { buffer };
  } catch {
    return undefined;
  }
}

const OG_IMAGE_PATTERN = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;
const OG_IMAGE_PATTERN_REVERSED =
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i;

/**
 * Scrapes DexScreener's own server-rendered chart-preview image off the
 * public token page (the `og:image` meta tag) and downloads it. There is no
 * official DexScreener API for this — checked 2026-07-28 against DexScreener's
 * documented endpoints, every one of which returns only `info.imageUrl` (the
 * token logo), never a chart screenshot. This is the exact same image
 * Telegram's own link-preview crawler already fetches when given the page
 * URL; downloading it ourselves just lets it be attached as a real sendPhoto
 * instead of relying on a link preview. Undocumented and scrape-based —
 * DexScreener changing its page markup, or an anti-bot block, both degrade
 * to undefined (never throws), same as any other best-effort enrichment
 * lookup in this codebase. In practice this always returns undefined from
 * this server today (Cloudflare blocks the page outright — see
 * resolveTradePhoto's own doc comment), so the real-data chart in
 * priceChart.ts is what actually renders every notification's photo; this
 * scrape is kept as the preferred tier in case that ever changes.
 */
export async function fetchDexScreenerChartImage(
  mint: string,
): Promise<ResolvedTradePhoto | undefined> {
  try {
    const pageRes = await fetch(dexscreenerChartUrl(mint), {
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NovaSolanaAISniper/1.0)' },
    });
    if (!pageRes.ok) return undefined;
    const html = await pageRes.text();
    const imageUrl =
      html.match(OG_IMAGE_PATTERN)?.[1] ?? html.match(OG_IMAGE_PATTERN_REVERSED)?.[1];
    if (!imageUrl) return undefined;
    return await downloadImage(imageUrl);
  } catch {
    return undefined;
  }
}

/**
 * Resolves the single best *price chart* photo for one trade notification —
 * never the token logo (2026-07-28 fix: the DexScreener og:image scrape below
 * is permanently blocked by Cloudflare from this server, confirmed with both
 * a plain fetch and a full headless-Chromium screenshot attempt, so it was
 * silently failing on every real trade and falling through to the token logo
 * — see priceChart.ts's own doc comment for the full investigation). Tier 1
 * is still the official DexScreener chart-preview image, kept in case this
 * server's IP is ever unblocked; tier 2 is a real-data chart we render
 * ourselves from GeckoTerminal OHLCV with the actual Buy/Sell fill points
 * marked. Undefined only if both real-data sources fail — the caller then
 * sends a text-only message, never a logo. Called once per trade and the
 * result reused for the channel post and every subscribed user's DM — never
 * re-fetched per recipient.
 */
export async function resolveTradePhoto(
  trade: TradeNotificationData,
): Promise<ResolvedTradePhoto | undefined> {
  const officialChart = await fetchDexScreenerChartImage(trade.mint);
  if (officialChart) return officialChart;
  return resolveRealPriceChartPhoto(trade);
}

/**
 * A previously-sent photo's Telegram file_id — reusing this via sendPhoto
 * (2026-07-29, broadcast queue) skips re-uploading the raw buffer, which
 * matters once a single trade's photo is being sent to 100k+ recipients.
 * broadcastWorker.ts captures this from the first successful delivery's
 * response (see sendTradeNotificationPhoto's return type below) and reuses
 * it for every subsequent recipient in that same broadcast.
 */
export interface ResolvedTradePhotoFileId {
  fileId: string;
}

export type SendableTradePhoto = ResolvedTradePhoto | ResolvedTradePhotoFileId;

function isFileId(photo: SendableTradePhoto): photo is ResolvedTradePhotoFileId {
  return 'fileId' in photo;
}

/**
 * The one send path for a Real Bot Trade notification — always sendPhoto
 * when a real price-chart photo was resolved (either the raw buffer or an
 * already-known file_id), sendMessage with the same caption text only in the
 * rare case neither chart source was available (never a fabricated
 * placeholder image, and never the token logo). Returns the raw grammy
 * Message shape (not just message_id) so a caller can capture `photo` for
 * file_id reuse — sendMessage's response has no `photo` field, hence it's
 * optional here.
 */
export async function sendTradeNotificationPhoto(
  bot: Bot,
  chatId: string,
  caption: string,
  photo: SendableTradePhoto | undefined,
): Promise<{ message_id: number; photo?: Array<{ file_id: string }> }> {
  if (photo) {
    const source = isFileId(photo) ? photo.fileId : new InputFile(photo.buffer);
    return bot.api.sendPhoto(chatId, source, {
      caption,
      parse_mode: 'Markdown',
    });
  }
  return bot.api.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
}
