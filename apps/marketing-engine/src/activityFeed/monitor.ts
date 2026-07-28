import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { Bot } from '@nova/telegram-bot';
import type { MarketDataClient, DexScreenerEnrichment } from '../marketData.js';
import { dexScreenerTokenUrl } from '../marketData.js';
import { sendBrandedMessage } from '../telegramSend.js';
import { fetchClosedTradesForDay } from '../tradeShowcase/data.js';
import {
  FEED_TYPES,
  fetchNewOpportunityCandidates,
  fetchMarketActivityCandidates,
  fetchTrendingTokenDbCandidates,
  fetchWhaleAlertCandidates,
  fetchSecurityAlertCandidates,
  isWeekAlreadySummarized,
  markActivityFeedPosted,
  type ActivityFeedType,
  type TrendingTokenDbCandidate,
} from './data.js';
import {
  formatNewOpportunityMessage,
  formatMarketActivityMessage,
  formatTrendingTokenMessage,
  formatWhaleAlertMessage,
  formatSecurityAlertMessage,
  formatWeeklySummaryMessage,
  computeDailySummaryStats,
} from './format.js';
import {
  randomIntervalMs,
  pickNextFeedType,
  utcDayKey,
  isDailyCapReached,
  type FeedTypeBacklog,
} from './scheduler.js';

export interface ActivityFeedMonitorDeps {
  prisma: PrismaClient;
  bot: Bot;
  chatId: string;
  logger: Logger;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  maxPostsPerDay: number;
  /** Fixed cutoff — see ACTIVITY_FEED_DEPLOYED_AT's own env.ts doc comment. */
  deployedAt: Date;
  /** Public DexScreener enrichment (logo/liquidity/market cap/volume/chain +
   * link) — see ../marketData.ts. A lookup failure degrades to "post the
   * real DB data without enrichment," never blocks the post. */
  marketData: MarketDataClient;
  /** Real, live 1h price-change bar a bot-detected token must currently
   * clear to qualify as "🔥 Trending Token" — see
   * ACTIVITY_FEED_TRENDING_MIN_H1_CHANGE_PERCENT's own env.ts doc comment. */
  trendingMinH1ChangePercent: number;
}

/** How many real candidates to pull per feed type per tick — small on
 * purpose, since only the first (oldest/most-recent) one is ever posted; this
 * just needs to be enough to answer "is there any real backlog at all." */
const CANDIDATE_FETCH_LIMIT = 5;

/** How often the monitor wakes up to check whether the randomly-scheduled
 * next post is due yet — much finer-grained than the 15-120 minute post
 * spacing itself, so a due post fires within a minute of its scheduled time
 * rather than potentially a full interval late. */
const CHECK_INTERVAL_MS = 60_000;

function utcWeekStart(d: Date): Date {
  const day = d.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMonday));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** pickNextFeedType only ever returns a type whose backlog count was > 0
 * (see scheduler.ts), so the corresponding candidates array is guaranteed
 * non-empty here — this just satisfies noUncheckedIndexedAccess without
 * silently swallowing a genuine invariant break. */
function requireFirst<T>(arr: T[], feedType: ActivityFeedType): T {
  const first = arr[0];
  if (!first) throw new Error(`activity feed: ${feedType} chosen with empty candidate list`);
  return first;
}

interface TrendingTokenPost extends TrendingTokenDbCandidate {
  enrichment: DexScreenerEnrichment;
}

/**
 * Premium Real-Data Telegram Activity Feed (2026-07-28 rebrand) — posts
 * premium-formatted messages to the public marketing channel sourced ONLY
 * from real rows plus real, live DexScreener public-market enrichment: new
 * tokens detected (🆕 New Opportunity), a rolling pool of bot-detected tokens
 * for quiet-day filler (📊 Market Activity), bot-detected tokens currently
 * clearing a real trending bar (🔥 Trending Token), real smart-wallet entries
 * (🐋 Whale Alert), real critical-security-gate passes (🛡️ Security Alert),
 * and a real weekly trade summary (📆 Weekly Summary). "🤖 Real Bot Trade"
 * and "📈 Daily Performance" are posted by the sibling ../tradeShowcase
 * module instead (it owns its own dedup) — not duplicated here.
 *
 * Deliberately mirrors TradeShowcaseMonitor's start/stop/tick shape and its
 * read-only-except-own-dedup-marker isolation — lives in apps/marketing-engine
 * so nothing here can affect buy/sell execution in apps/api.
 *
 * Pacing: a random delay in [minIntervalMinutes, maxIntervalMinutes] between
 * posts (see scheduler.ts), capped at maxPostsPerDay/UTC day. There is no
 * minimum-posts-per-day: a tick where every feed type has zero real,
 * unposted backlog posts nothing and simply reschedules.
 */
export class ActivityFeedMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private nextPostDueAt: number | undefined;
  private lastPostedType: ActivityFeedType | undefined;
  private postsToday = 0;
  private postsTodayKey: string | undefined;

  constructor(private readonly deps: ActivityFeedMonitorDeps) {}

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
      this.deps.logger.error({ err }, 'activity feed: tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private scheduleNextCheck(now: number): void {
    this.nextPostDueAt =
      now + randomIntervalMs(this.deps.minIntervalMinutes, this.deps.maxIntervalMinutes);
  }

  private async tickInner(): Promise<void> {
    const now = Date.now();

    if (this.nextPostDueAt === undefined) {
      // First tick after (re)start — schedules the first random delay rather
      // than posting immediately, same "no burst on boot" rationale as
      // TradeShowcaseMonitor's send spacing.
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

    const posted = await this.postOneRealEvent(new Date(now));
    if (posted) {
      this.postsToday += 1;
    }
    // Reschedule regardless of whether anything was posted this tick — a
    // quiet moment with no real backlog simply tries again after another
    // random delay, never fabricating content to fill the gap.
    this.scheduleNextCheck(now);
  }

  /** Fetches each raw DB trending candidate's live DexScreener stats and
   * keeps only the ones currently clearing trendingMinH1ChangePercent — a
   * candidate below the bar is simply left off this tick's result (its
   * ActivityFeedPost row stays unwritten, so it's re-checked on a later tick
   * within the same day-bucket window rather than being posted anyway or
   * permanently skipped). */
  private async getTrendingPosts(now: Date): Promise<TrendingTokenPost[]> {
    const dbCandidates = await fetchTrendingTokenDbCandidates(
      this.deps.prisma,
      CANDIDATE_FETCH_LIMIT,
      this.deps.deployedAt,
      now,
    );
    const checked = await Promise.all(
      dbCandidates.map(async (c) => ({
        c,
        enrichment: await this.deps.marketData.fetchEnrichment(c.mint),
      })),
    );
    const posts: TrendingTokenPost[] = [];
    for (const { c, enrichment } of checked) {
      if (
        enrichment?.priceChangeH1Percent !== undefined &&
        enrichment.priceChangeH1Percent >= this.deps.trendingMinH1ChangePercent
      ) {
        posts.push({ ...c, enrichment });
      }
    }
    return posts;
  }

  private async postOneRealEvent(now: Date): Promise<boolean> {
    const { prisma } = this.deps;

    const [
      newOpportunities,
      marketActivity,
      trendingPosts,
      whaleAlerts,
      securityAlerts,
      weeklyDue,
    ] = await Promise.all([
      fetchNewOpportunityCandidates(prisma, CANDIDATE_FETCH_LIMIT, this.deps.deployedAt),
      fetchMarketActivityCandidates(prisma, CANDIDATE_FETCH_LIMIT, this.deps.deployedAt, now),
      this.getTrendingPosts(now),
      fetchWhaleAlertCandidates(prisma, CANDIDATE_FETCH_LIMIT, this.deps.deployedAt),
      fetchSecurityAlertCandidates(prisma, CANDIDATE_FETCH_LIMIT, this.deps.deployedAt),
      this.isWeeklySummaryDue(now),
    ]);

    const backlogs: FeedTypeBacklog[] = [
      { type: FEED_TYPES.NEW_OPPORTUNITY, count: newOpportunities.length },
      { type: FEED_TYPES.MARKET_ACTIVITY, count: marketActivity.length },
      { type: FEED_TYPES.TRENDING_TOKEN, count: trendingPosts.length },
      { type: FEED_TYPES.WHALE_ALERT, count: whaleAlerts.length },
      { type: FEED_TYPES.SECURITY_ALERT, count: securityAlerts.length },
      { type: FEED_TYPES.WEEKLY_SUMMARY, count: weeklyDue ? 1 : 0 },
    ];

    const chosen = pickNextFeedType(backlogs, this.lastPostedType);
    if (!chosen) {
      this.deps.logger.info('activity feed: no real, unposted backlog this tick — skipping');
      return false;
    }

    try {
      switch (chosen) {
        case FEED_TYPES.NEW_OPPORTUNITY: {
          const c = requireFirst(newOpportunities, chosen);
          const enrichment = await this.deps.marketData.fetchEnrichment(c.mint);
          await this.sendToken(formatNewOpportunityMessage(c, enrichment), c.mint, enrichment);
          await markActivityFeedPosted(prisma, FEED_TYPES.NEW_OPPORTUNITY, c.id);
          break;
        }
        case FEED_TYPES.MARKET_ACTIVITY: {
          const c = requireFirst(marketActivity, chosen);
          const enrichment = await this.deps.marketData.fetchEnrichment(c.mint);
          await this.sendToken(formatMarketActivityMessage(c, enrichment), c.mint, enrichment);
          await markActivityFeedPosted(prisma, FEED_TYPES.MARKET_ACTIVITY, c.id);
          break;
        }
        case FEED_TYPES.TRENDING_TOKEN: {
          const c = requireFirst(trendingPosts, chosen);
          await this.sendToken(formatTrendingTokenMessage(c, c.enrichment), c.mint, c.enrichment);
          await markActivityFeedPosted(prisma, FEED_TYPES.TRENDING_TOKEN, c.id);
          break;
        }
        case FEED_TYPES.WHALE_ALERT: {
          const c = requireFirst(whaleAlerts, chosen);
          const enrichment = await this.deps.marketData.fetchEnrichment(c.mint);
          await this.sendToken(formatWhaleAlertMessage(c, enrichment), c.mint, enrichment);
          await markActivityFeedPosted(prisma, FEED_TYPES.WHALE_ALERT, c.id);
          break;
        }
        case FEED_TYPES.SECURITY_ALERT: {
          const c = requireFirst(securityAlerts, chosen);
          const enrichment = await this.deps.marketData.fetchEnrichment(c.mint);
          await this.sendToken(formatSecurityAlertMessage(c, enrichment), c.mint, enrichment);
          await markActivityFeedPosted(prisma, FEED_TYPES.SECURITY_ALERT, c.id);
          break;
        }
        case FEED_TYPES.WEEKLY_SUMMARY: {
          await this.postWeeklySummary(now);
          break;
        }
      }
    } catch (err) {
      // Real event stays unposted (no dedup row written on failure) — picked
      // up again next tick rather than silently dropped, same convention as
      // TradeShowcaseMonitor.
      this.deps.logger.error(
        { err, feedType: chosen },
        'activity feed: failed to post — will retry later',
      );
      return false;
    }

    this.lastPostedType = chosen;
    this.deps.logger.info({ feedType: chosen }, 'activity feed: posted');
    return true;
  }

  private async sendToken(
    text: string,
    mint: string,
    enrichment: DexScreenerEnrichment | undefined,
  ): Promise<void> {
    await sendBrandedMessage(this.deps.bot, this.deps.chatId, text, {
      logoUrl: enrichment?.logoUrl,
      linkPreviewUrl: dexScreenerTokenUrl(mint),
    });
  }

  private lastCompleteWeek(now: Date): { start: Date; end: Date } {
    const end = utcWeekStart(now);
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { start, end };
  }

  private async isWeeklySummaryDue(now: Date): Promise<boolean> {
    const { start, end } = this.lastCompleteWeek(now);
    if (end <= this.deps.deployedAt) return false;
    const already = await isWeekAlreadySummarized(this.deps.prisma, isoDate(start));
    return !already;
  }

  private async postWeeklySummary(now: Date): Promise<void> {
    const { start, end } = this.lastCompleteWeek(now);
    const effectiveStart = start > this.deps.deployedAt ? start : this.deps.deployedAt;
    const trades = await fetchClosedTradesForDay(this.deps.prisma, effectiveStart, end);
    const weekEndInclusive = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const label = `${isoDate(start)} to ${isoDate(weekEndInclusive)}`;
    const stats = computeDailySummaryStats(label, trades);
    await sendBrandedMessage(this.deps.bot, this.deps.chatId, formatWeeklySummaryMessage(stats));
    await markActivityFeedPosted(this.deps.prisma, FEED_TYPES.WEEKLY_SUMMARY, isoDate(start));
  }
}
