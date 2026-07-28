import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import {
  formatTradePhotoCaption,
  resolveTradePhoto,
  sendTradeNotificationPhoto,
  type ResolvedTradePhoto,
  type TradeNotificationData,
  type Bot,
} from '@nova/telegram-bot';
import type { MarketDataClient, DexScreenerEnrichment } from '../marketData.js';
import { sendBrandedMessage } from '../telegramSend.js';
import {
  fetchShowcaseEligibleTrades,
  fetchClosedTradesForDay,
  fetchSubscribedTelegramIds,
  markTradeShowcased,
  type ShowcaseTrade,
} from './data.js';
import { formatDailySummaryMessage, computeDailySummaryStats } from './format.js';

/** Maps this module's Prisma-backed trade/enrichment shapes onto the
 * generic, Prisma-free TradeNotificationData shape the shared
 * apps/telegram-bot notification builder expects — see that module's own
 * doc comment for why the builder lives there instead of here. */
function toTradeNotificationData(
  trade: ShowcaseTrade,
  enrichment: DexScreenerEnrichment | undefined,
): TradeNotificationData {
  return {
    mint: trade.mint,
    tokenName: trade.tokenName,
    tokenSymbol: trade.tokenSymbol,
    dex: trade.dex,
    buyAt: trade.buyAt,
    sellAt: trade.sellAt,
    roiPercent: trade.roiPercent,
    pnlUsd: trade.pnlUsd,
    aiScore: trade.aiScore,
    buySignature: trade.buySignature,
    sellSignature: trade.sellSignature,
    liquidityUsd: enrichment?.liquidityUsd,
    marketCapUsd: enrichment?.marketCapUsd,
    volume24hUsd: enrichment?.volume24hUsd,
    entryPriceUsd: trade.entryPriceUsd,
    exitPriceUsd: trade.exitPriceUsd,
  };
}

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
 * Real Bot Trade DM broadcast (2026-07-28): every per-trade post (not the
 * daily summary) is also DM'd identically to every user who has ever started
 * the bot — see dmSubscribedUsers below. The channel post is never removed
 * or replaced by this; both go out for every eligible trade.
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
        const notification = toTradeNotificationData(trade, enrichment);
        const caption = formatTradePhotoCaption(notification);
        // Fetched once per trade (real DexScreener chart preview, falling
        // back to a self-rendered real-data price chart — never the token
        // logo, see resolveTradePhoto's own doc comment) and reused for the
        // channel post and every subscribed user's DM, never re-downloaded
        // per recipient.
        const photo = await resolveTradePhoto(notification);
        await sendTradeNotificationPhoto(this.deps.bot, this.deps.chatId, caption, photo);
        await this.dmSubscribedUsers(trade.positionId, caption, photo);
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

  /**
   * Real Bot Trade DM broadcast (2026-07-28): every user who has ever
   * started the bot (User.telegramId set) gets the identical sendPhoto
   * notification — same photo, same caption — direct in their own chat, in
   * addition to (never instead of) the public channel post above.
   * Independent of SnipeConfig activity: this is a broadcast to every
   * registered user, not the narrower "active sniper" fan-out
   * NotificationService already does for the BUY/SELL card images.
   * Best-effort per recipient (logged, not thrown) so one blocked chat, or
   * a Telegram outage, never stops the channel post or the dedup marker
   * above from going through.
   */
  private async dmSubscribedUsers(
    positionId: string,
    caption: string,
    photo: ResolvedTradePhoto | undefined,
  ): Promise<void> {
    const chatIds = await fetchSubscribedTelegramIds(this.deps.prisma);
    await Promise.all(
      chatIds.map(async (chatId) => {
        try {
          await sendTradeNotificationPhoto(this.deps.bot, chatId, caption, photo);
        } catch (err) {
          this.deps.logger.error(
            { err, positionId, chatId },
            'trade showcase: failed to DM subscribed user',
          );
        }
      }),
    );
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
