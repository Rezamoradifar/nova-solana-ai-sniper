import {
  escapeMd,
  usd,
  pnlEmoji,
  fmtDate,
  fmtHoldingTimeShort,
  shortKey,
} from '@nova/telegram-bot';
import { NOVA_BRAND_FOOTER } from '../brand.js';
import type { DexScreenerEnrichment } from '../marketData.js';
import type { ShowcaseTrade } from './data.js';

export function solscanTxUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

export function solscanTokenUrl(mint: string): string {
  return `https://solscan.io/token/${mint}`;
}

export function dexscreenerChartUrl(mint: string): string {
  return `https://dexscreener.com/solana/${mint}`;
}

function roiStr(percent: number): string {
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

function score(n: number | undefined): string | undefined {
  if (n === undefined) return undefined;
  return `${Math.round(n)}/100`;
}

/** Real DexScreener stats, shared with ../activityFeed/format.ts's own
 * enrichmentLines — kept as a separate small copy rather than a cross-import
 * since tradeShowcase and activityFeed are deliberately independent siblings
 * (see either module's own isolation doc comment), and this is three lines
 * of pure formatting with zero shared state. */
function enrichmentLines(e: DexScreenerEnrichment | undefined): string[] {
  if (!e) return [];
  const lines = [`Chain: ${e.chain}`];
  if (e.liquidityUsd !== undefined) lines.push(`Liquidity: ${usd(e.liquidityUsd)}`);
  if (e.marketCapUsd !== undefined) lines.push(`Market Cap: ${usd(e.marketCapUsd)}`);
  if (e.volume24hUsd !== undefined) lines.push(`24h Volume: ${usd(e.volume24hUsd)}`);
  return lines;
}

/**
 * One real closed trade, exactly as it happened — no profit-range filter
 * applied before this is called (see data.ts's own doc comment), so this
 * renders losses in the same format as wins, just with a red emoji instead
 * of green (pnlEmoji already does this).
 *
 * "Screenshot of the DexScreener chart" (spec requirement): deliberately NOT
 * a captured/rendered image — this repo has no headless-browser dependency,
 * and scraping+re-hosting a third party's chart image would itself be a
 * fabrication risk (stale/mismatched by the time it's posted). Instead the
 * DexScreener chart link is sent as a live, un-suppressed Telegram link
 * preview: Telegram fetches DexScreener's own server-rendered OG chart image
 * for that pair at send time and renders it inline — a real, current
 * screenshot sourced directly from DexScreener, with zero extra
 * infrastructure and zero risk of showing a stale/wrong chart. `enrichment`
 * is optional and additive (liquidity/market cap/volume/chain, logo
 * delivered as the message's photo attachment instead — see
 * ../telegramSend.ts) — its absence never blocks posting the real trade data.
 */
export function formatTradeShowcaseMessage(
  trade: ShowcaseTrade,
  enrichment?: DexScreenerEnrichment,
): string {
  const label = trade.tokenSymbol
    ? escapeMd(trade.tokenSymbol)
    : trade.tokenName
      ? escapeMd(trade.tokenName)
      : shortKey(trade.mint);
  const holdingMs = trade.sellAt.getTime() - trade.buyAt.getTime();

  const lines = [
    `🤖 *REAL BOT TRADE*`,
    '',
    `${pnlEmoji(trade.pnlUsd)} *${label}*`,
    '',
    // Explicit "Name:" line, independent of the headline label above (which
    // prefers the shorter symbol) — always present so "Token name" is never
    // only implied. Reports honestly when unknown rather than reusing the
    // symbol/mint as if it were a real name.
    `Name: ${trade.tokenName ? escapeMd(trade.tokenName) : '(unknown)'}`,
    `Token: \`${escapeMd(trade.mint)}\` ([Solscan](${solscanTokenUrl(trade.mint)}))`,
    `DEX: ${escapeMd(trade.dex)}`,
    `Buy: ${fmtDate(trade.buyAt)} UTC`,
    `Sell: ${fmtDate(trade.sellAt)} UTC (held ${fmtHoldingTimeShort(holdingMs)})`,
    `ROI: *${roiStr(trade.roiPercent)}*`,
    `PnL: *${usd(trade.pnlUsd)}*`,
  ];

  const aiScore = score(trade.aiScore);
  if (aiScore) lines.push(`AI Score: *${aiScore}*`);
  lines.push(...enrichmentLines(enrichment));

  if (trade.buySignature) {
    lines.push(`[Buy tx on Solscan](${solscanTxUrl(trade.buySignature)})`);
  }
  if (trade.sellSignature) {
    lines.push(`[Sell tx on Solscan](${solscanTxUrl(trade.sellSignature)})`);
  }
  lines.push(`[View chart on DexScreener](${dexscreenerChartUrl(trade.mint)})`);
  lines.push(NOVA_BRAND_FOOTER);

  return lines.join('\n');
}

export interface DailySummaryStats {
  dateLabel: string;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  totalPnlUsd: number;
  bestTrade: ShowcaseTrade | undefined;
  worstTrade: ShowcaseTrade | undefined;
}

export function computeDailySummaryStats(
  dateLabel: string,
  trades: ShowcaseTrade[],
): DailySummaryStats {
  const wins = trades.filter((t) => t.pnlUsd >= 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const totalPnlUsd = trades.reduce((sum, t) => sum + t.pnlUsd, 0);
  const bestTrade = trades.reduce<ShowcaseTrade | undefined>(
    (best, t) => (!best || t.roiPercent > best.roiPercent ? t : best),
    undefined,
  );
  const worstTrade = trades.reduce<ShowcaseTrade | undefined>(
    (worst, t) => (!worst || t.roiPercent < worst.roiPercent ? t : worst),
    undefined,
  );

  return {
    dateLabel,
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    totalPnlUsd,
    bestTrade,
    worstTrade,
  };
}

/**
 * The daily aggregate report — real totals for the full day, whatever they
 * were. No survivorship bias: tradeCount/winCount/lossCount cover every
 * eligible trade that closed that day, not a curated subset, so a day with a
 * net loss reports as a net loss here.
 */
export function formatDailySummaryMessage(stats: DailySummaryStats): string {
  if (stats.tradeCount === 0) {
    return (
      `📈 *DAILY PERFORMANCE — ${escapeMd(stats.dateLabel)}*\n\n` +
      `No closed trades today.${NOVA_BRAND_FOOTER}`
    );
  }

  const winRate = (stats.winCount / stats.tradeCount) * 100;
  const lines = [
    `📈 *DAILY PERFORMANCE — ${escapeMd(stats.dateLabel)}*`,
    '',
    `Trades closed: *${stats.tradeCount}* (${stats.winCount} win, ${stats.lossCount} loss)`,
    `Win rate: *${winRate.toFixed(1)}%*`,
    `Total PnL: *${usd(stats.totalPnlUsd)}*`,
  ];

  if (stats.bestTrade) {
    const label = stats.bestTrade.tokenSymbol ?? shortKey(stats.bestTrade.mint);
    lines.push(`Best: *${escapeMd(label)}* ${roiStr(stats.bestTrade.roiPercent)}`);
  }
  if (stats.worstTrade && stats.worstTrade.roiPercent < 0) {
    const label = stats.worstTrade.tokenSymbol ?? shortKey(stats.worstTrade.mint);
    lines.push(`Worst: *${escapeMd(label)}* ${roiStr(stats.worstTrade.roiPercent)}`);
  }
  lines.push(NOVA_BRAND_FOOTER);

  return lines.join('\n');
}
