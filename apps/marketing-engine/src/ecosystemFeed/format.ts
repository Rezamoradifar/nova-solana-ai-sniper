import { fmtDate, shortKey, usd } from '@nova/telegram-bot';
import type { TokenStatCardBrief } from '../visuals/tokenStatCard.js';
import type { SmartMoneyTradeCandidate } from './data.js';
import type { ShowcaseTrade } from '../tradeShowcase/data.js';

/**
 * Ecosystem Feed (2026-07-31) — HTML formatting for the 5 Phase 1
 * categories. Every field traces back to a real, already-fetched number the
 * caller (monitor.ts) passes in — this module never fetches anything itself
 * and never invents a value; a field that's genuinely unknown is simply
 * omitted, same "never fabricate" convention as activityFeed/format.ts.
 *
 * HTML, not Markdown — this feed's explicit requirement — so escaping is
 * `escapeHtml` (&, <, >), not escapeMd, and the brand footer/links use HTML
 * tags directly.
 */

/** Telegram HTML parse_mode only requires escaping these three characters —
 * unlike Markdown's much larger special-character set (_, *, [, ], `, etc). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const NOVA_BRAND_FOOTER_HTML = '\n\n🔷 <b>Nova Solana AI Sniper</b>';

/** Telegram's hard limit on a photo caption. */
const PHOTO_CAPTION_LIMIT = 1024;

/** Truncates the body only, always keeping the brand footer intact — same
 * convention as tradeNotification.ts's formatTradePhotoCaption. */
export function truncateForPhotoCaption(html: string): string {
  if (html.length <= PHOTO_CAPTION_LIMIT) return html;
  const footer = `\n…${NOVA_BRAND_FOOTER_HTML}`;
  return `${html.slice(0, Math.max(0, PHOTO_CAPTION_LIMIT - footer.length))}${footer}`;
}

function tokenLabel(mint: string, name: string | undefined, symbol: string | undefined): string {
  if (symbol) return escapeHtml(symbol);
  if (name) return escapeHtml(name);
  return escapeHtml(shortKey(mint));
}

/** Compact K/M/B formatting for the image (which has far less room than a
 * caption line) — `undefined` reads as "N/A", never a fabricated 0. */
export function compactUsd(n: number | undefined): string {
  if (n === undefined) return 'N/A';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function pctLabel(pct: number | undefined): string {
  if (pct === undefined) return 'N/A';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function explorerLinksLine(mint: string): string {
  return (
    `<a href="https://dexscreener.com/solana/${mint}">DexScreener</a> · ` +
    `<a href="https://solscan.io/token/${mint}">Solscan</a> · ` +
    `<a href="https://birdeye.so/token/${mint}?chain=solana">Birdeye</a>`
  );
}

/** Shared context for the 4 arbitrary-token categories (Trending, Smart
 * Money, High Volume, Hidden Gem) — deliberately plain optional numbers, not
 * a DexScreenerEnrichment, so a caller can populate it from a live
 * enrichment lookup OR from a candidate's own already-stored Token fields
 * (Hidden Gems don't need a fresh live call — see data.ts's own doc
 * comment), whichever is the real, already-available source for that
 * category. */
export interface TokenCardContext {
  mint: string;
  name: string | undefined;
  symbol: string | undefined;
  categoryTag: string;
  changePercent: number | undefined;
  marketCapUsd: number | undefined;
  liquidityUsd: number | undefined;
  volumeUsd: number | undefined;
  riskScore: number | undefined;
}

export function buildTokenStatCardBrief(ctx: TokenCardContext): TokenStatCardBrief {
  return {
    tokenName: ctx.name ?? shortKey(ctx.mint),
    tokenSymbol: ctx.symbol ?? '—',
    changePercent: ctx.changePercent ?? 0,
    changeLabel: pctLabel(ctx.changePercent),
    categoryTag: ctx.categoryTag,
    status: 'LIVE',
    marketCapLabel: compactUsd(ctx.marketCapUsd),
    liquidityLabel: compactUsd(ctx.liquidityUsd),
    volumeLabel: compactUsd(ctx.volumeUsd),
    riskScoreLabel: ctx.riskScore !== undefined ? `${Math.round(ctx.riskScore)}/100` : 'N/A',
  };
}

export function buildTokenCaptionHtml(
  ctx: TokenCardContext,
  headlineHtml: string,
  timestamp: Date,
): string {
  const lines = [
    headlineHtml,
    '',
    `<b>Token:</b> ${tokenLabel(ctx.mint, ctx.name, ctx.symbol)}`,
    `<b>Mint:</b> <code>${escapeHtml(ctx.mint)}</code>`,
  ];
  if (ctx.changePercent !== undefined)
    lines.push(`<b>1h Change:</b> ${pctLabel(ctx.changePercent)}`);
  if (ctx.marketCapUsd !== undefined) lines.push(`<b>Market Cap:</b> ${usd(ctx.marketCapUsd)}`);
  if (ctx.liquidityUsd !== undefined) lines.push(`<b>Liquidity:</b> ${usd(ctx.liquidityUsd)}`);
  if (ctx.volumeUsd !== undefined) lines.push(`<b>24h Volume:</b> ${usd(ctx.volumeUsd)}`);
  if (ctx.riskScore !== undefined)
    lines.push(`<b>Risk Score:</b> ${Math.round(ctx.riskScore)}/100`);
  lines.push(`🕒 ${fmtDate(timestamp)} UTC`);
  lines.push(explorerLinksLine(ctx.mint));
  lines.push(NOVA_BRAND_FOOTER_HTML);
  return truncateForPhotoCaption(lines.join('\n'));
}

export function buildSmartMoneyCaptionHtml(
  c: SmartMoneyTradeCandidate,
  ctx: Pick<TokenCardContext, 'marketCapUsd' | 'liquidityUsd' | 'volumeUsd' | 'changePercent'>,
): string {
  const lines = [
    '🧠 <b>SMART MONEY TRADE</b>',
    '',
    `<b>Wallet:</b> <code>${escapeHtml(shortKey(c.walletAddress))}</code>`,
    `<b>Token:</b> ${tokenLabel(c.mint, c.tokenName, c.tokenSymbol)}`,
    `<b>Confidence:</b> ${Math.round(c.confidenceScore)}%`,
  ];
  if (c.winRate !== undefined) lines.push(`<b>Historical Win Rate:</b> ${Math.round(c.winRate)}%`);
  if (c.medianRoiPercent !== undefined) {
    lines.push(`<b>Median ROI:</b> ${pctLabel(c.medianRoiPercent)}`);
  }
  if (c.entryMarketCapUsd !== undefined) {
    lines.push(`<b>Entry Market Cap:</b> ${usd(c.entryMarketCapUsd)}`);
  }
  if (ctx.marketCapUsd !== undefined)
    lines.push(`<b>Current Market Cap:</b> ${usd(ctx.marketCapUsd)}`);
  if (ctx.liquidityUsd !== undefined) lines.push(`<b>Liquidity:</b> ${usd(ctx.liquidityUsd)}`);
  lines.push(`🕒 ${fmtDate(c.entryAt)} UTC`);
  lines.push(explorerLinksLine(c.mint));
  lines.push(NOVA_BRAND_FOOTER_HTML);
  return truncateForPhotoCaption(lines.join('\n'));
}

export function buildSmartMoneyStatCardBrief(
  c: SmartMoneyTradeCandidate,
  ctx: Pick<TokenCardContext, 'marketCapUsd' | 'liquidityUsd' | 'volumeUsd' | 'changePercent'>,
): TokenStatCardBrief {
  return buildTokenStatCardBrief({
    mint: c.mint,
    name: c.tokenName,
    symbol: c.tokenSymbol,
    categoryTag: 'SMART MONEY TRADE',
    changePercent: ctx.changePercent,
    marketCapUsd: ctx.marketCapUsd,
    liquidityUsd: ctx.liquidityUsd,
    volumeUsd: ctx.volumeUsd,
    riskScore: c.confidenceScore,
  });
}

/** Folds "Biggest Profit"/"Biggest ROI"/"Biggest Winners" into one
 * leaderboard category (see project plan) — the headline dynamically picks
 * whichever framing is more impressive for this specific trade, so the same
 * real trade doesn't always read the same way. Uses ShowcaseTrade's already-
 * resolved real numbers (pnlUsd, roiPercent, entry/exit price, tx
 * signatures) — no new computation here. */
export function buildBiggestWinnerCaptionHtml(t: ShowcaseTrade): string {
  const leadWithRoi = t.roiPercent >= 100;
  const headline = leadWithRoi ? '📈 <b>MASSIVE ROI</b>' : '💰 <b>BIGGEST PROFIT</b>';
  const lines = [
    headline,
    '',
    `<b>Token:</b> ${tokenLabel(t.mint, t.tokenName, t.tokenSymbol)}`,
    `<b>Profit:</b> ${usd(t.pnlUsd)}`,
    `<b>ROI:</b> ${pctLabel(t.roiPercent)}`,
    `<b>Entry:</b> ${usd(t.entryPriceUsd)}`,
  ];
  if (t.exitPriceUsd !== undefined) lines.push(`<b>Exit:</b> ${usd(t.exitPriceUsd)}`);
  if (t.aiScore !== undefined) lines.push(`<b>AI Score:</b> ${Math.round(t.aiScore)}/100`);
  lines.push(`🕒 ${fmtDate(t.sellAt)} UTC`);
  const txLinks: string[] = [];
  if (t.buySignature) txLinks.push(`<a href="https://solscan.io/tx/${t.buySignature}">Buy Tx</a>`);
  if (t.sellSignature)
    txLinks.push(`<a href="https://solscan.io/tx/${t.sellSignature}">Sell Tx</a>`);
  txLinks.push(`<a href="https://dexscreener.com/solana/${t.mint}">DexScreener</a>`);
  lines.push(txLinks.join(' · '));
  lines.push(NOVA_BRAND_FOOTER_HTML);
  return truncateForPhotoCaption(lines.join('\n'));
}
