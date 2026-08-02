import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { Bot } from '@nova/telegram-bot';
import { resolveTradePhoto } from '@nova/telegram-bot';
import type { MarketDataClient, DexScreenerEnrichment } from '../marketData.js';
import { sendBrandedPhotoHtml } from '../telegramSend.js';
import { buildTokenButtonRows } from '../tokenButtons.js';
import { randomIntervalMs, utcDayKey, isDailyCapReached } from '../activityFeed/scheduler.js';
import {
  fetchNetworkTradeCandidates,
  markNetworkTradePosted,
  scoreNetworkTradeCandidate,
  type NetworkTradeCandidate,
} from './data.js';
import { buildNetworkTradeCaptionHtml } from './format.js';

/**
 * Network Trade Feed (2026-08-02) — a curated feed of OTHER real wallets'
 * completed trades (never this bot's own — see tradeShowcase for that
 * separate category), sourced only from SmartWalletTokenEntry rows
 * smartWalletTracker.ts has resolved to a real, on-chain-verified full exit.
 * "Curated" is the operative word: unlike activityFeed/ecosystemFeed (post
 * the oldest/first real backlog item), this monitor scores every unposted
 * candidate and posts only the single best one per tick — the "select only
 * the best trades, never publish every detected trade" requirement. Same
 * day-quota/random-interval pacing model as ActivityFeedMonitor (own scoped
 * import, not a duplicate — see scheduler.ts's own doc comment on why that
 * pick logic was generalized for reuse); maxPostsPerDay is a CEILING only
 * (10-40/day, configurable), never a floor — a day with fewer than 10 real,
 * fully-resolved smart-wallet exits simply posts fewer, same "never
 * fabricate to hit a target" convention as every other feed here.
 */
export interface NetworkTradeFeedMonitorDeps {
  prisma: PrismaClient;
  bot: Bot;
  chatId: string;
  logger: Logger;
  marketData: MarketDataClient;
  /** Fixed cutoff — see NETWORK_TRADE_FEED_DEPLOYED_AT's own env.ts doc
   * comment. */
  deployedAt: Date;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  maxPostsPerDay: number;
  websiteUrl?: string;
}

/** How many of the most recent unposted completed trades to consider per
 * tick before picking the single best-scored one — bounded so a backlog
 * spike can't turn one tick into an unbounded scoring pass. */
const CANDIDATE_FETCH_LIMIT = 30;

/** Same "wake up far more often than the post spacing itself" rationale as
 * ActivityFeedMonitor's own CHECK_INTERVAL_MS. */
const CHECK_INTERVAL_MS = 60_000;

export class NetworkTradeFeedMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private nextPostDueAt: number | undefined;
  private postsToday = 0;
  private postsTodayKey: string | undefined;
  private botUsername: string | undefined;

  constructor(private readonly deps: NetworkTradeFeedMonitorDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
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
      await this.tickInner();
    } catch (err) {
      this.deps.logger.error({ err }, 'network trade feed: tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private scheduleNextCheck(now: number): void {
    this.nextPostDueAt =
      now + randomIntervalMs(this.deps.minIntervalMinutes, this.deps.maxIntervalMinutes);
  }

  private async resolveBotUsername(): Promise<void> {
    if (this.botUsername) return;
    try {
      const me = await this.deps.bot.api.getMe();
      this.botUsername = me.username;
    } catch (err) {
      this.deps.logger.warn(
        { err },
        'network trade feed: failed to resolve bot username for Track button',
      );
    }
  }

  private async tickInner(): Promise<void> {
    const now = Date.now();

    if (this.nextPostDueAt === undefined) {
      // First tick after (re)start — schedules the first random delay rather
      // than posting immediately, same "no burst on boot" rationale as
      // TradeShowcaseMonitor/ActivityFeedMonitor.
      this.scheduleNextCheck(now);
      return;
    }
    if (now < this.nextPostDueAt) return;

    const today = utcDayKey(new Date(now));
    if (this.postsTodayKey !== today) {
      this.postsTodayKey = today;
      this.postsToday = 0;
    }
    if (isDailyCapReached(this.postsToday, this.deps.maxPostsPerDay)) {
      this.scheduleNextCheck(now);
      return;
    }

    const posted = await this.postBestCandidate(new Date(now));
    if (posted) this.postsToday += 1;
    // Reschedule regardless of whether anything was posted — a tick with no
    // real, unposted completed trade simply tries again later.
    this.scheduleNextCheck(now);
  }

  private async postBestCandidate(now: Date): Promise<boolean> {
    const candidates = await fetchNetworkTradeCandidates(
      this.deps.prisma,
      CANDIDATE_FETCH_LIMIT,
      this.deps.deployedAt,
    );
    if (candidates.length === 0) {
      this.deps.logger.info('network trade feed: no real, unposted completed trades this tick');
      return false;
    }

    await this.resolveBotUsername();

    // Live enrichment (current liquidity/market cap, and 24h volume for
    // scoring's trending proxy) fetched for every candidate up front so the
    // "best trade" pick reflects today's numbers, not stale ones. A failed
    // lookup degrades that one candidate to score as if volume were 0 —
    // never dropped from consideration just because one live call failed.
    const withEnrichment = await Promise.all(
      candidates.map(async (c) => ({
        c,
        enrichment: await this.deps.marketData.fetchEnrichment(c.mint),
      })),
    );

    const best = withEnrichment
      .map(({ c, enrichment }) => ({
        c,
        enrichment,
        score: scoreNetworkTradeCandidate({
          realizedRoiPercent: c.realizedRoiPercent,
          realizedPnlUsd: c.realizedPnlUsd,
          walletConfidenceScore: c.walletConfidenceScore,
          entryAmountSol: c.entryAmountSol,
          volume24hUsd: enrichment?.volume24hUsd,
        }),
      }))
      .sort((a, b) => b.score - a.score)[0]!;

    try {
      await this.postCandidate(best.c, best.enrichment, now);
      await markNetworkTradePosted(this.deps.prisma, best.c.entryId);
    } catch (err) {
      // Real trade stays unposted (no dedup row written on failure) —
      // retried next tick rather than silently dropped, same convention as
      // every other feed's post-failure handling here.
      this.deps.logger.error(
        { err, entryId: best.c.entryId },
        'network trade feed: failed to post — will retry later',
      );
      return false;
    }

    this.deps.logger.info(
      { entryId: best.c.entryId, score: best.score, mint: best.c.mint },
      'network trade feed: posted',
    );
    return true;
  }

  private async postCandidate(
    c: NetworkTradeCandidate,
    enrichment: DexScreenerEnrichment | undefined,
    now: Date,
  ): Promise<void> {
    // Reuses the same real-data price-chart resolution as tradeShowcase's
    // "Real Bot Trade" photo (official DexScreener chart, falling back to a
    // GeckoTerminal OHLCV chart we render ourselves) — this trade has a real
    // entry/exit fill just like the bot's own, so the same chart makes
    // sense. The caption/buttons below are this feed's own, HTML-formatted
    // and visually distinct, never tradeShowcase's Markdown format.
    const photo = await resolveTradePhoto({
      mint: c.mint,
      tokenName: c.tokenName,
      tokenSymbol: c.tokenSymbol,
      dex: c.dex,
      buyAt: c.entryAt,
      sellAt: c.exitAt,
      roiPercent: c.realizedRoiPercent,
      pnlUsd: c.realizedPnlUsd,
      aiScore: c.aiScore,
      buySignature: c.entrySignature,
      sellSignature: c.exitSignature,
      liquidityUsd: enrichment?.liquidityUsd,
      marketCapUsd: enrichment?.marketCapUsd,
      volume24hUsd: enrichment?.volume24hUsd,
      entryPriceUsd: c.entryPriceUsd ?? 0,
      exitPriceUsd: c.exitPriceUsd,
    });
    const caption = buildNetworkTradeCaptionHtml(
      c,
      { liquidityUsd: enrichment?.liquidityUsd, marketCapUsd: enrichment?.marketCapUsd },
      now,
    );
    const buttons = buildTokenButtonRows({
      mint: c.mint,
      dex: c.dex,
      botUsername: this.botUsername,
      websiteUrl: this.deps.websiteUrl,
    });
    await sendBrandedPhotoHtml(this.deps.bot, this.deps.chatId, photo, caption, buttons);
  }
}
