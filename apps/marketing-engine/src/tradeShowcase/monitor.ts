import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { Bot } from '@nova/telegram-bot';
import type { MarketDataClient } from '../marketData.js';
import { sendBrandedMessage } from '../telegramSend.js';
import {
  fetchShowcaseEligibleTrades,
  fetchClosedTradesForDay,
  markTradeShowcased,
} from './data.js';
import {
  formatTradeShowcaseMessage,
  formatDailySummaryMessage,
  computeDailySummaryStats,
  dexscreenerChartUrl,
} from './format.js';

export interface TradeShowcaseMonitorDeps {
  prisma: PrismaClient;
  bot: Bot;
  chatId: string;
  logger: Logger;
  maxPostsPerTick: number;
  /** Fixed cutoff — see TRADE_SHOWCASE_DEPLOYED_AT's own env.ts doc comment.
   * No trade that closed before this is ever eligible, per-trade or in a
   * daily summary. */
  deployedAt: Date;
  /** Public DexScreener enrichment (logo/liquidity/market cap/volume/chain)
   * — see ../marketData.ts. A lookup failure degrades to "post the real
   * trade data without enrichment," never blocks the post. */
  marketData: MarketDataClient;
}

/** Telegram's per-chat flood limit is roughly 1 message/second sustained —
 * spacing sends out avoids a burst of showcase posts (or the daily summary
 * landing right after one) getting rate-limited mid-batch. */
const SEND_SPACING_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcDateLabel(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Daily Trade Showcase (2026-07-27) — publishes every real, non-paper,
 * non-honeypot-flagged closed trade to the public marketing channel as it
 * closes (spread across the day by maxPostsPerTick, not a burst), plus one
 * aggregate summary per completed UTC day. Same start/stop/tick shape as
 * apps/api/src/detection/migrationMonitor.ts — a `ticking` guard so a slow
 * tick (Telegram send latency) can never overlap with the next timer fire.
 *
 * Read-only against trading data other than its own two dedup markers
 * (Position.showcasePostedAt, TradeShowcaseDailySummary) — lives in
 * apps/marketing-engine specifically so it has no code path that can affect
 * buy/sell execution in apps/api.
 */
export class TradeShowcaseMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly deps: TradeShowcaseMonitorDeps) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.postEligibleTrades();
      await this.postDailySummaryIfDue();
    } catch (err) {
      this.deps.logger.error({ err }, 'trade showcase: tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private async postEligibleTrades(): Promise<void> {
    const trades = await fetchShowcaseEligibleTrades(
      this.deps.prisma,
      this.deps.maxPostsPerTick,
      this.deps.deployedAt,
    );
    for (const trade of trades) {
      try {
        const enrichment = await this.deps.marketData.fetchEnrichment(trade.mint);
        const text = formatTradeShowcaseMessage(trade, enrichment);
        await sendBrandedMessage(this.deps.bot, this.deps.chatId, text, {
          logoUrl: enrichment?.logoUrl,
          linkPreviewUrl: dexscreenerChartUrl(trade.mint),
        });
        await markTradeShowcased(this.deps.prisma, trade.positionId);
        this.deps.logger.info(
          { positionId: trade.positionId, mint: trade.mint, roiPercent: trade.roiPercent },
          'trade showcase: posted trade',
        );
      } catch (err) {
        // Leaves showcasePostedAt null — picked up again next tick rather
        // than silently dropped on a transient Telegram/DB failure.
        this.deps.logger.error(
          { err, positionId: trade.positionId, mint: trade.mint },
          'trade showcase: failed to post trade — will retry next tick',
        );
      }
      await sleep(SEND_SPACING_MS);
    }
  }

  private async postDailySummaryIfDue(): Promise<void> {
    const todayStart = utcDayStart(new Date());
    const summaryDayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const summaryDayEnd = todayStart;

    // A day that ended entirely before deployment has nothing eligible by
    // definition — skip it outright rather than posting a misleading "0
    // closed trades" for a day that predates this feature (or recording a
    // summary row for it at all).
    if (summaryDayEnd <= this.deps.deployedAt) return;

    const existing = await this.deps.prisma.tradeShowcaseDailySummary.findUnique({
      where: { summaryDate: summaryDayStart },
    });
    if (existing) return;

    // Clamped so a day deployment happened partway through only summarizes
    // the post-deployment portion of it, same cutoff as the per-trade feed.
    const effectiveDayStart =
      summaryDayStart > this.deps.deployedAt ? summaryDayStart : this.deps.deployedAt;
    const trades = await fetchClosedTradesForDay(
      this.deps.prisma,
      effectiveDayStart,
      summaryDayEnd,
    );
    const stats = computeDailySummaryStats(utcDateLabel(summaryDayStart), trades);
    const text = formatDailySummaryMessage(stats);

    try {
      const sent = await sendBrandedMessage(this.deps.bot, this.deps.chatId, text);
      await this.deps.prisma.tradeShowcaseDailySummary.create({
        data: { summaryDate: summaryDayStart, telegramMessageId: sent.message_id },
      });
      this.deps.logger.info(
        { summaryDate: utcDateLabel(summaryDayStart), tradeCount: stats.tradeCount },
        'trade showcase: posted daily summary',
      );
    } catch (err) {
      // Unique constraint on summaryDate means a concurrent/duplicate insert
      // attempt fails loudly rather than double-posting — logged and retried
      // next tick either way (no row was created on failure).
      this.deps.logger.error(
        { err, summaryDate: utcDateLabel(summaryDayStart) },
        'trade showcase: failed to post daily summary — will retry next tick',
      );
    }
  }
}
