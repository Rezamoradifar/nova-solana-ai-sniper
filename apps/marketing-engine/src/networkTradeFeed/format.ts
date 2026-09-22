import { shortKey, fmtDate, fmtHoldingTimeShort } from '@nova/telegram-bot';
import type { NetworkTradeCandidate, NetworkTradeCategory } from './data.js';
import type { NetworkTradeCardBrief } from '../visuals/networkTradeCard.js';

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
  volume24hUsd: number | undefined;
}

/** One badge line per category — always shown alongside, never instead of,
 * the 🟢/🔴 profit-or-loss header below (see buildNetworkTradeCaptionHtml's
 * own doc comment). */
const CATEGORY_LABEL: Record<NetworkTradeCategory, string> = {
  TRENDING_TOKEN: '🔥 TRENDING TOKEN',
  SMART_MONEY: '🧠 SMART MONEY',
  WHALE_WALLET: '🐋 WHALE WALLET',
  NETWORK_PROFIT: '🌐 NETWORK TRADE',
  NETWORK_LOSS: '🌐 NETWORK TRADE',
};

export const NOVA_BRAND_FOOTER_HTML = '\n\n🔷 <b>GSP Bank Sniper</b> · Network Feed';

const PHOTO_CAPTION_LIMIT = 1024;

export function truncateForPhotoCaption(html: string): string {
  if (html.length <= PHOTO_CAPTION_LIMIT) return html;
  const footer = `\n…${NOVA_BRAND_FOOTER_HTML}`;
  return `${html.slice(0, Math.max(0, PHOTO_CAPTION_LIMIT - footer.length))}${footer}`;
}

/**
 * Every field the project's Network Trade Feed spec requires, always present
 * as its own line — a value that couldn't be resolved (aiScore, live
 * liquidity/market cap/volume) renders as a literal "N/A", never a
 * fabricated number, same convention as tradeShowcase's own "Real Bot Trade"
 * caption. `category` (see data.ts's categorizeNetworkTrade) drives the
 * badge line only — the 🟢/🔴 profit-or-loss header always reflects the
 * trade's actual sign, so a SMART_MONEY or TRENDING_TOKEN post never hides
 * whether it was a win or a loss.
 */
export function buildNetworkTradeCaptionHtml(
  c: NetworkTradeCandidate,
  enrichment: NetworkTradeEnrichment,
  now: Date,
  category: NetworkTradeCategory,
): string {
  const isProfit = c.realizedPnlUsd >= 0;
  const badge = CATEGORY_LABEL[category];
  const header = isProfit ? `🟢 <b>PROFIT</b> · ${badge}` : `🔴 <b>LOSS</b> · ${badge}`;
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
    `📊 Volume (24h): ${compactUsd(enrichment.volume24hUsd)}`,
    `🤖 AI Score: ${c.aiScore !== undefined ? `${Math.round(c.aiScore)}/100` : NOT_AVAILABLE}`,
    `🔀 DEX: ${escapeHtml(c.dex)}`,
    `👛 Wallet: <code>${escapeHtml(shortKey(c.walletAddress))}</code>`,
    `🧾 Tx: <code>${escapeHtml(shortKey(c.exitSignature))}</code>`,
    `🕐 ${escapeHtml(fmtDate(now))} UTC`,
  ];

  return truncateForPhotoCaption(lines.join('\n') + NOVA_BRAND_FOOTER_HTML);
}

/** Plain-text (no emoji — the generated image has no emoji font loaded)
 * counterpart to CATEGORY_LABEL above, for the image's category tag line. */
const CATEGORY_TAG_PLAIN: Record<NetworkTradeCategory, string> = {
  TRENDING_TOKEN: 'TRENDING TOKEN',
  SMART_MONEY: 'SMART MONEY',
  WHALE_WALLET: 'WHALE WALLET',
  NETWORK_PROFIT: 'NETWORK TRADE',
  NETWORK_LOSS: 'NETWORK TRADE',
};

/**
 * Converts a real candidate + live enrichment into the premium generated
 * image's brief (see visuals/networkTradeCard.ts) — every field the project
 * spec requires on the image (logo is handled separately, by the caller
 * fetching it via fetchNetworkTradeLogo.ts and passing the buffer straight to
 * renderNetworkTradeCard). Reuses this file's own priceLabel/compactUsd so
 * the image and the caption always render identical numbers for the same
 * trade.
 */
export function buildNetworkTradeCardBrief(
  c: NetworkTradeCandidate,
  enrichment: NetworkTradeEnrichment,
  category: NetworkTradeCategory,
): NetworkTradeCardBrief {
  const roiStr = `${c.realizedRoiPercent >= 0 ? '+' : ''}${c.realizedRoiPercent.toFixed(1)}%`;
  return {
    tokenName: c.tokenName ?? shortKey(c.mint),
    tokenSymbol: c.tokenSymbol ?? '—',
    roiPercent: c.realizedRoiPercent,
    roiLabel: roiStr,
    pnlLabel: `${formatUsdSigned(c.realizedPnlUsd)} · ${formatSolSigned(c.realizedPnlSol)}`,
    categoryTag: CATEGORY_TAG_PLAIN[category],
    marketCapLabel: compactUsd(enrichment.marketCapUsd),
    liquidityLabel: compactUsd(enrichment.liquidityUsd),
    volumeLabel: compactUsd(enrichment.volume24hUsd),
    aiScoreLabel: c.aiScore !== undefined ? `${Math.round(c.aiScore)}/100` : NOT_AVAILABLE,
    entryLabel: priceLabel(c.entryPriceUsd),
    exitLabel: priceLabel(c.exitPriceUsd),
  };
}
