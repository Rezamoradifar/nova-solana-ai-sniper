import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { Bot } from '@nova/telegram-bot';
import type { MarketDataClient, DexScreenerEnrichment } from '../marketData.js';
import { sendBrandedPhotoHtml } from '../telegramSend.js';
import { buildTokenButtonRows } from '../tokenButtons.js';
import { randomIntervalMs, utcDayKey, isDailyCapReached } from '../activityFeed/scheduler.js';
import { renderNetworkTradeCard } from '../visuals/networkTradeCard.js';
import { fetchNetworkTradeLogo } from '../visuals/fetchNetworkTradeLogo.js';
import {
  fetchNetworkTradeCandidates,
  markNetworkTradePosted,
  scoreNetworkTradeCandidate,
  categorizeNetworkTrade,
  classifyNetworkTradePostBucket,
  NETWORK_TRADE_DAILY_BUCKET_CAPS,
  type NetworkTradeCandidate,
  type NetworkTradePostBucket,
} from './data.js';
import { buildNetworkTradeCaptionHtml, buildNetworkTradeCardBrief } from './format.js';
import { enqueueNetworkTradeBroadcast } from './broadcastQueue.js';

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
 * pick logic was generalized for reuse).
 *
 * Daily mix (2026-08-03 project spec): each of the three ROI-based buckets
 * from data.ts's classifyNetworkTradePostBucket (HIGH_PROFIT/SMALL_PROFIT/
 * LOSS_BAND) has its OWN daily ceiling (NETWORK_TRADE_DAILY_BUCKET_CAPS —
 * 20/5/5, summing to the spec's 30/day). Every ceiling is a CEILING only,
 * never a floor — a bucket with fewer real, fully-resolved matching exits
 * than its cap simply posts fewer that day, same "never fabricate/substitute
 * to hit a target" convention as every other feed here. `maxPostsPerDay`
 * remains as an extra overall safety ceiling on top of the per-bucket caps.
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

function freshBucketCounts(): Record<NetworkTradePostBucket, number> {
  return { HIGH_PROFIT: 0, SMALL_PROFIT: 0, LOSS_BAND: 0 };
}

export class NetworkTradeFeedMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private nextPostDueAt: number | undefined;
  private postsTodayByBucket: Record<NetworkTradePostBucket, number> = freshBucketCounts();
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
      this.postsTodayByBucket = freshBucketCounts();
    }
    const totalPostedToday =
      this.postsTodayByBucket.HIGH_PROFIT +
      this.postsTodayByBucket.SMALL_PROFIT +
      this.postsTodayByBucket.LOSS_BAND;
    if (isDailyCapReached(totalPostedToday, this.deps.maxPostsPerDay) || this.allBucketsFull()) {
      this.scheduleNextCheck(now);
      return;
    }

    const postedBucket = await this.postBestCandidate(new Date(now));
    if (postedBucket) this.postsTodayByBucket[postedBucket] += 1;
    // Reschedule regardless of whether anything was posted — a tick with no
    // real, unposted completed trade simply tries again later.
    this.scheduleNextCheck(now);
  }

  /** True once every bucket has independently hit its own daily cap — no
   * point fetching candidates this tick if there's nowhere left to post
   * one, same short-circuit rationale as the maxPostsPerDay check above. */
  private allBucketsFull(): boolean {
    return (Object.keys(NETWORK_TRADE_DAILY_BUCKET_CAPS) as NetworkTradePostBucket[]).every(
      (bucket) => this.postsTodayByBucket[bucket] >= NETWORK_TRADE_DAILY_BUCKET_CAPS[bucket],
    );
  }

  private async postBestCandidate(now: Date): Promise<NetworkTradePostBucket | undefined> {
    const candidates = await fetchNetworkTradeCandidates(
      this.deps.prisma,
      CANDIDATE_FETCH_LIMIT,
      this.deps.deployedAt,
    );
    if (candidates.length === 0) {
      this.deps.logger.info('network trade feed: no real, unposted completed trades this tick');
      return undefined;
    }

    // Only a candidate whose ROI lands in one of the three spec'd bands, AND
    // whose bucket still has room today, is eligible at all — see data.ts's
    // classifyNetworkTradePostBucket doc comment for why everything else
    // (a small loss, or one worse than -25%) is never eligible for this feed.
    const eligible = candidates
      .map((c) => ({ c, bucket: classifyNetworkTradePostBucket(c.realizedRoiPercent) }))
      .filter(
        (x): x is { c: NetworkTradeCandidate; bucket: NetworkTradePostBucket } =>
          x.bucket !== undefined &&
          this.postsTodayByBucket[x.bucket] < NETWORK_TRADE_DAILY_BUCKET_CAPS[x.bucket],
      );
    if (eligible.length === 0) {
      this.deps.logger.info(
        'network trade feed: no real candidate in an open quota bucket this tick',
      );
      return undefined;
    }

    await this.resolveBotUsername();

    // Live enrichment (current liquidity/market cap, and 24h volume for
    // scoring's trending proxy) fetched for every eligible candidate up
    // front so the "best trade" pick reflects today's numbers, not stale
    // ones. A failed lookup degrades that one candidate to score as if
    // volume were 0 — never dropped from consideration just because one
    // live call failed.
    const withEnrichment = await Promise.all(
      eligible.map(async ({ c, bucket }) => ({
        c,
        bucket,
        enrichment: await this.deps.marketData.fetchEnrichment(c.mint),
      })),
    );

    const best = withEnrichment
      .map(({ c, bucket, enrichment }) => ({
        c,
        bucket,
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
      return undefined;
    }

    this.deps.logger.info(
      { entryId: best.c.entryId, score: best.score, mint: best.c.mint, bucket: best.bucket },
      'network trade feed: posted',
    );
    return best.bucket;
  }

  private async postCandidate(
    c: NetworkTradeCandidate,
    enrichment: DexScreenerEnrichment | undefined,
    now: Date,
  ): Promise<void> {
    const category = categorizeNetworkTrade({
      realizedPnlUsd: c.realizedPnlUsd,
      walletConfidenceScore: c.walletConfidenceScore,
      volume24hUsd: enrichment?.volume24hUsd,
      priceChangeH1Percent: enrichment?.priceChangeH1Percent,
    });
    const cardEnrichment = {
      liquidityUsd: enrichment?.liquidityUsd,
      marketCapUsd: enrichment?.marketCapUsd,
      volume24hUsd: enrichment?.volume24hUsd,
    };

    // Own generated branded card (visuals/networkTradeCard.ts), not
    // tradeShowcase's price-chart photo — the project spec calls for a
    // dedicated premium image (logo/ROI/PnL/entry-exit/AI score/etc grid),
    // and this is the ONE category showing another wallet's trade, so it
    // must never be visually confusable with a "Real Bot Trade" chart photo.
    // Logo fetch is best-effort — a missing/undecodable logo just omits the
    // circle (see fetchNetworkTradeLogo.ts's own doc comment).
    const logoBuffer = await fetchNetworkTradeLogo(enrichment?.logoUrl);
    const brief = buildNetworkTradeCardBrief(c, cardEnrichment, category);
    const photo = await renderNetworkTradeCard(brief, logoBuffer);

    const caption = buildNetworkTradeCaptionHtml(c, cardEnrichment, now, category);
    const buttons = buildTokenButtonRows({
      mint: c.mint,
      dex: c.dex,
      botUsername: this.botUsername,
      websiteUrl: this.deps.websiteUrl,
    });
    const sent = await sendBrandedPhotoHtml(
      this.deps.bot,
      this.deps.chatId,
      photo,
      caption,
      buttons,
    );
    await this.enqueueBroadcastToRegisteredUsers(c.entryId, caption, buttons, sent);
  }

  /**
   * "Both the Telegram Bot and Telegram Channel receive identical posts"
   * (2026-08-03 project spec) — fans this exact channel post out to every
   * registered bot user via the durable NetworkTradeBroadcastWorker queue
   * (see broadcastQueue.ts/broadcastWorker.ts), reusing the SAME photo
   * file_id/caption/buttons the channel just got rather than re-rendering.
   * Best-effort: the channel post has already landed by the time this runs,
   * so a failure here (missing file_id, DB error) is logged and swallowed,
   * never thrown — it must never cause a duplicate channel repost via a
   * retried tick.
   */
  private async enqueueBroadcastToRegisteredUsers(
    entryId: string,
    caption: string,
    buttons: ReturnType<typeof buildTokenButtonRows>,
    sent: { message_id: number; photo?: { file_id: string }[] },
  ): Promise<void> {
    const fileId = sent.photo?.[sent.photo.length - 1]?.file_id;
    if (!fileId) {
      this.deps.logger.warn(
        { entryId },
        'network trade feed: channel post had no photo file_id — skipping DM broadcast to registered users',
      );
      return;
    }
    try {
      const { recipientCount } = await enqueueNetworkTradeBroadcast(
        this.deps.prisma,
        entryId,
        caption,
        fileId,
        JSON.stringify(buttons),
      );
      this.deps.logger.info(
        { entryId, recipientCount },
        'network trade feed: enqueued DM broadcast to registered users',
      );
    } catch (err) {
      this.deps.logger.error(
        { err, entryId },
        'network trade feed: failed to enqueue DM broadcast — channel post still stands',
      );
    }
  }
}
