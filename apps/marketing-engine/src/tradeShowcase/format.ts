import { escapeMd, usd, shortKey } from '@nova/telegram-bot';
import { NOVA_BRAND_FOOTER } from '../brand.js';
import type { ShowcaseTrade } from './data.js';

// Per-trade formatting (the "Real Bot Trade" message itself) lives in
// apps/telegram-bot/src/tradeNotification.ts as of 2026-07-28 — every real
// closed trade is now sent as a sendPhoto (DexScreener chart preview or
// token-logo fallback) with the caption built there, by both this module's
// TradeShowcaseMonitor (channel + every subscribed user's DM) and
// apps/telegram-bot's own /testtrade command, so the two can never drift
// apart. Only the daily aggregate summary (never a per-trade photo) still
// lives here.

function roiStr(percent: number): string {
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
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
