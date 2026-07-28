import { escapeMd, usd, fmtDate, shortKey } from '@nova/telegram-bot';
import { NOVA_BRAND_FOOTER } from '../brand.js';
import { dexScreenerTokenUrl, type DexScreenerEnrichment } from '../marketData.js';
import { computeDailySummaryStats, type DailySummaryStats } from '../tradeShowcase/format.js';
import type {
  NewOpportunityCandidate,
  MarketActivityCandidate,
  TrendingTokenDbCandidate,
  WhaleAlertCandidate,
  SecurityAlertCandidate,
} from './data.js';

/**
 * Premium Real-Data Telegram Activity Feed (2026-07-28 rebrand) — every
 * formatter here renders fields taken directly off its real-data candidate
 * (see data.ts) plus, where noted, a real DexScreener enrichment lookup
 * (see ../marketData.ts), with no randomized/invented values anywhere. A
 * field that's genuinely unknown (e.g. no liquidityUsd resolved yet) is
 * simply omitted from the message rather than filled in with a placeholder
 * that could read as real.
 */

function tokenLabel(mint: string, name: string | undefined, symbol: string | undefined): string {
  if (symbol) return escapeMd(symbol);
  if (name) return escapeMd(name);
  return shortKey(mint);
}

function score(n: number | undefined): string | undefined {
  if (n === undefined) return undefined;
  return `${Math.round(n)}/100`;
}

/** Real DexScreener stats (liquidity/market cap/24h volume/chain), shared
 * across every single-token category per requirement #9 — omits any field
 * that isn't currently resolvable rather than showing a placeholder. No
 * logo line here: the logo (when available) is delivered as the message's
 * photo attachment itself (see ../telegramSend.ts), not as a text line. */
function enrichmentLines(e: DexScreenerEnrichment | undefined): string[] {
  if (!e) return [];
  const lines = [`Chain: ${e.chain}`];
  if (e.liquidityUsd !== undefined) lines.push(`Liquidity: ${usd(e.liquidityUsd)}`);
  if (e.marketCapUsd !== undefined) lines.push(`Market Cap: ${usd(e.marketCapUsd)}`);
  if (e.volume24hUsd !== undefined) lines.push(`24h Volume: ${usd(e.volume24hUsd)}`);
  return lines;
}

/** requirement #10: a DexScreener link on every token message — always
 * derivable from the mint alone, independent of whether the enrichment
 * lookup itself succeeded. */
function dexScreenerLine(mint: string): string {
  return `[View on DexScreener](${dexScreenerTokenUrl(mint)})`;
}

export function formatNewOpportunityMessage(
  c: NewOpportunityCandidate,
  enrichment?: DexScreenerEnrichment,
): string {
  const lines = [
    `🆕 *NEW OPPORTUNITY*`,
    '',
    `Token: *${tokenLabel(c.mint, c.name, c.symbol)}*`,
    `Mint: \`${escapeMd(c.mint)}\``,
    `DEX: ${escapeMd(c.dex)}`,
  ];
  if (c.liquidityUsd !== undefined) lines.push(`Liquidity: ${usd(c.liquidityUsd)}`);
  if (c.marketCapUsd !== undefined) lines.push(`Market Cap: ${usd(c.marketCapUsd)}`);
  const aiScore = score(c.aiScore);
  if (aiScore) lines.push(`AI Score: *${aiScore}*`);
  lines.push(...enrichmentLines(enrichment));
  lines.push(`🕒 ${fmtDate(c.firstSeenAt)} UTC`);
  lines.push(dexScreenerLine(c.mint));
  lines.push(NOVA_BRAND_FOOTER);
  return lines.join('\n');
}

/** Fallback content for a quiet stretch with no bot trade to showcase
 * (requirement #3) — a bot-detected token (never one the bot hasn't seen),
 * reported with real, current public market stats. */
export function formatMarketActivityMessage(
  c: MarketActivityCandidate,
  enrichment: DexScreenerEnrichment | undefined,
): string {
  const lines = [
    `📊 *MARKET ACTIVITY*`,
    '',
    `Token: *${tokenLabel(c.mint, c.name, c.symbol)}*`,
    `Mint: \`${escapeMd(c.mint)}\``,
    `DEX: ${escapeMd(c.dex)}`,
    ...enrichmentLines(enrichment),
    `🕒 ${fmtDate(c.detectedAt)} UTC`,
    dexScreenerLine(c.mint),
    NOVA_BRAND_FOOTER,
  ];
  return lines.join('\n');
}

export function formatTrendingTokenMessage(
  c: TrendingTokenDbCandidate,
  enrichment: DexScreenerEnrichment,
): string {
  const changeStr =
    enrichment.priceChangeH1Percent !== undefined
      ? `${enrichment.priceChangeH1Percent >= 0 ? '+' : ''}${enrichment.priceChangeH1Percent.toFixed(1)}%`
      : undefined;
  const lines = [
    `🔥 *TRENDING TOKEN*`,
    '',
    `Token: *${tokenLabel(c.mint, c.name, c.symbol)}*`,
    `Mint: \`${escapeMd(c.mint)}\``,
  ];
  if (changeStr) lines.push(`1h Price Change: *${changeStr}*`);
  lines.push(...enrichmentLines(enrichment));
  lines.push(`🕒 ${fmtDate(c.detectedAt)} UTC`);
  lines.push(dexScreenerLine(c.mint));
  lines.push(NOVA_BRAND_FOOTER);
  return lines.join('\n');
}

export function formatWhaleAlertMessage(
  c: WhaleAlertCandidate,
  enrichment?: DexScreenerEnrichment,
): string {
  const lines = [
    `🐋 *WHALE ALERT*`,
    '',
    `Wallet: \`${shortKey(c.walletAddress)}\``,
    `Token: *${tokenLabel(c.mint, c.tokenName, c.tokenSymbol)}*`,
  ];
  if (c.entryMarketCapUsd !== undefined) {
    lines.push(`Entry Market Cap: ${usd(c.entryMarketCapUsd)}`);
  }
  lines.push(`Confidence: *${Math.round(c.confidenceScore)}%*`);
  if (c.winRate !== undefined) lines.push(`Historical Win Rate: *${Math.round(c.winRate)}%*`);
  lines.push(...enrichmentLines(enrichment));
  lines.push(`🕒 ${fmtDate(c.entryAt)} UTC`);
  lines.push(dexScreenerLine(c.mint));
  lines.push(NOVA_BRAND_FOOTER);
  return lines.join('\n');
}

export function formatSecurityAlertMessage(
  c: SecurityAlertCandidate,
  enrichment?: DexScreenerEnrichment,
): string {
  const lines = [
    `🛡️ *SECURITY ALERT*`,
    '',
    `Token: *${tokenLabel(c.mint, c.name, c.symbol)}*`,
    `Safety Score: *${score(c.safetyScore)}*`,
    `Cleared: mint/freeze authority, LP lock, honeypot heuristic, holder concentration`,
    ...enrichmentLines(enrichment),
    `🕒 ${fmtDate(c.detectedAt)} UTC`,
    dexScreenerLine(c.mint),
    NOVA_BRAND_FOOTER,
  ];
  return lines.join('\n');
}

export { computeDailySummaryStats };
export type { DailySummaryStats };

export function formatWeeklySummaryMessage(stats: DailySummaryStats): string {
  if (stats.tradeCount === 0) {
    return `📆 *WEEKLY SUMMARY — ${escapeMd(stats.dateLabel)}*\n\nNo closed trades this week.${NOVA_BRAND_FOOTER}`;
  }
  const winRate = (stats.winCount / stats.tradeCount) * 100;
  const lines = [
    `📆 *WEEKLY SUMMARY — ${escapeMd(stats.dateLabel)}*`,
    '',
    `Trades closed: *${stats.tradeCount}* (${stats.winCount} win, ${stats.lossCount} loss)`,
    `Win rate: *${winRate.toFixed(1)}%*`,
    `Total PnL: *${usd(stats.totalPnlUsd)}*`,
  ];
  if (stats.bestTrade) {
    const label = stats.bestTrade.tokenSymbol ?? shortKey(stats.bestTrade.mint);
    const roi = stats.bestTrade.roiPercent;
    lines.push(`Best: *${escapeMd(label)}* ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`);
  }
  if (stats.worstTrade && stats.worstTrade.roiPercent < 0) {
    const label = stats.worstTrade.tokenSymbol ?? shortKey(stats.worstTrade.mint);
    lines.push(`Worst: *${escapeMd(label)}* ${stats.worstTrade.roiPercent.toFixed(1)}%`);
  }
  lines.push(NOVA_BRAND_FOOTER);
  return lines.join('\n');
}
