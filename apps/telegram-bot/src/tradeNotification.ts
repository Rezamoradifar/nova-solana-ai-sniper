import { InputFile, type Bot } from 'grammy';
import { escapeMd, fmtDate, fmtHoldingTimeShort, pnlEmoji, shortKey, usd } from './ui/format.js';

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
    `🔷 *Nova Solana AI Sniper*`,
  ];

  const text = lines.join('\n');
  if (text.length <= PHOTO_CAPTION_LIMIT) return text;

  // Truncates the body only — the DexScreener link and brand footer (the two
  // things a shortened caption must never lose) are always appended intact.
  const footer = `\n…\n[View on DexScreener](${dexscreenerChartUrl(trade.mint)})\n\n🔷 *Nova Solana AI Sniper*`;
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
 * lookup in this codebase — so a scrape failure always falls back to the
 * token-logo tier in resolveTradePhoto below, never blocks the underlying
 * real trade notification.
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
 * Resolves the single best photo for one trade notification — the real
 * DexScreener chart preview first, the token logo second (no headless-browser
 * chart-rendering fallback: a real per-trade page screenshot would need a
 * bundled-Chromium dependency this codebase deliberately doesn't carry, see
 * this feature's own design discussion), undefined if neither is available.
 * Called once per trade and the result reused for the channel post and every
 * subscribed user's DM — never re-fetched per recipient.
 */
export async function resolveTradePhoto(
  mint: string,
  logoUrl: string | undefined,
): Promise<ResolvedTradePhoto | undefined> {
  const chart = await fetchDexScreenerChartImage(mint);
  if (chart) return chart;
  if (logoUrl) return downloadImage(logoUrl);
  return undefined;
}

/**
 * The one send path for a Real Bot Trade notification — always sendPhoto
 * when a real photo (chart or logo) was resolved, sendMessage with the same
 * caption text only in the rare case neither image source was available
 * (never a fabricated placeholder image).
 */
export async function sendTradeNotificationPhoto(
  bot: Bot,
  chatId: string,
  caption: string,
  photo: ResolvedTradePhoto | undefined,
): Promise<{ message_id: number }> {
  if (photo) {
    return bot.api.sendPhoto(chatId, new InputFile(photo.buffer), {
      caption,
      parse_mode: 'Markdown',
    });
  }
  return bot.api.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
}
