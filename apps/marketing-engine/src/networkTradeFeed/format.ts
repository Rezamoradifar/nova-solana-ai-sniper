import { shortKey, fmtDate, fmtHoldingTimeShort } from '@nova/telegram-bot';
import type { NetworkTradeCandidate } from './data.js';

/**
 * Network Trade Feed HTML formatting (2026-08-02) — deliberately its own
 * caption, distinct from tradeShowcase's Markdown "Real Bot Trade" format
 * (see tradeNotification.ts) and from ecosystemFeed's arbitrary-token
 * captions: this is the ONE category showing a completed trade that belongs
 * to a wallet other than this bot's own, so the wallet address and a
 * "Network Trade" tag are load-bearing, not incidental — Real Bot Trades and
 * Network Trades must never be visually confusable (project requirement).
 * Own escapeHtml copy rather than an import from ecosystemFeed/format.ts —
 * same per-module isolation convention as this package's other sibling feed
 * folders.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const NOT_AVAILABLE = 'N/A';

function tokenLabel(mint: string, name: string | undefined, symbol: string | undefined): string {
  if (symbol) return escapeHtml(symbol);
  if (name) return escapeHtml(name);
  return escapeHtml(shortKey(mint));
}

/** Signed SOL amount, e.g. "+1.250 SOL" / "-0.400 SOL". */
export function formatSolSigned(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}${Math.abs(n).toFixed(3)} SOL`;
}

/** Signed USD amount, e.g. "+$1,250.00" / "-$400.00". */
export function formatUsdSigned(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function priceLabel(n: number | undefined): string {
  if (n === undefined) return NOT_AVAILABLE;
  return n < 0.01 ? `$${n.toFixed(8)}` : `$${n.toFixed(4)}`;
}

function compactUsd(n: number | undefined): string {
  if (n === undefined) return NOT_AVAILABLE;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export interface NetworkTradeEnrichment {
  liquidityUsd: number | undefined;
  marketCapUsd: number | undefined;
}

export const NOVA_BRAND_FOOTER_HTML = '\n\n🔷 <b>Nova Solana AI Sniper</b> · Network Feed';

const PHOTO_CAPTION_LIMIT = 1024;

export function truncateForPhotoCaption(html: string): string {
  if (html.length <= PHOTO_CAPTION_LIMIT) return html;
  const footer = `\n…${NOVA_BRAND_FOOTER_HTML}`;
  return `${html.slice(0, Math.max(0, PHOTO_CAPTION_LIMIT - footer.length))}${footer}`;
}

/**
 * Every field the project's Network Trade Feed spec requires, always present
 * as its own line — a value that couldn't be resolved (aiScore, live
 * liquidity/market cap) renders as a literal "N/A", never a fabricated
 * number, same convention as tradeShowcase's own "Real Bot Trade" caption.
 */
export function buildNetworkTradeCaptionHtml(
  c: NetworkTradeCandidate,
  enrichment: NetworkTradeEnrichment,
  now: Date,
): string {
  const isProfit = c.realizedPnlUsd >= 0;
  const header = isProfit ? '🟢 <b>PROFIT — NETWORK TRADE</b>' : '🔴 <b>LOSS — NETWORK TRADE</b>';
  const label = tokenLabel(c.mint, c.tokenName, c.tokenSymbol);
  const roiStr = `${c.realizedRoiPercent >= 0 ? '+' : ''}${c.realizedRoiPercent.toFixed(1)}%`;
  const holdingMs = c.exitAt.getTime() - c.entryAt.getTime();

  const lines = [
    header,
    `${label}`,
    '',
    `📈 ROI: <b>${roiStr}</b>`,
    `💰 PnL: <b>${formatUsdSigned(c.realizedPnlUsd)}</b> (${formatSolSigned(c.realizedPnlSol)})`,
    `🎯 Entry: ${priceLabel(c.entryPriceUsd)}`,
    `🏁 Exit: ${priceLabel(c.exitPriceUsd)}`,
    `⏱ Holding Time: ${fmtHoldingTimeShort(holdingMs)}`,
    `💧 Liquidity: ${compactUsd(enrichment.liquidityUsd)}`,
    `🏦 Market Cap: ${compactUsd(enrichment.marketCapUsd)}`,
    `🤖 AI Score: ${c.aiScore !== undefined ? `${Math.round(c.aiScore)}/100` : NOT_AVAILABLE}`,
    `🔀 DEX: ${escapeHtml(c.dex)}`,
    `👛 Wallet: <code>${escapeHtml(shortKey(c.walletAddress))}</code>`,
    `🕐 ${escapeHtml(fmtDate(now))} UTC`,
  ];

  return truncateForPhotoCaption(lines.join('\n') + NOVA_BRAND_FOOTER_HTML);
}
