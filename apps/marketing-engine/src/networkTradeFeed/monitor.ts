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
  categorizeNetworkTrade,
  isNetworkTradeCandidateEligible,
  compareNetworkTradeCandidatesByPriority,
  type NetworkTradeCandidate,
} from './data.js';
import { buildNetworkTradeCaptionHtml, buildNetworkTradeCardBrief } from './format.js';
import { enqueueNetworkTradeBroadcast } from './broadcastQueue.js';

/**
 * Network Trade Feed (2026-08-02) — a curated feed of OTHER real wallets'
 * completed trades (never this bot's own — see tradeShowcase for that
 * separate category), sourced only from SmartWalletTokenEntry rows
 * smartWalletTracker.ts has resolved to a real, on-chain-verified full exit.
 * "Curated" is the operative word: unlike activityFeed/ecosystemFeed (post
 * the oldest/first real backlog item), this monitor evaluates every
 * unposted candidate and posts only the single best one per tick — the
 * "select only the best trades, never publish every detected trade"
 * requirement. Same day-quota/random-interval pacing model as
 * ActivityFeedMonitor (own scoped import, not a duplicate — see
 * scheduler.ts's own doc comment on why that pick logic was generalized for
 * reuse).
 *
 * Scheduler rewrite (2026-08-05 spec): replaces the old per-ROI-bucket daily
 * quota (which left the feed silent for days whenever real trades didn't
 * land in one of three narrow bands — see this feed's own incident writeup)
 * with a single overall daily ceiling (`maxPostsPerDay`, ~48 to match "about
 * 2 posts/hour") plus a flat 20-40 minute random interval (average 30min ==
 * 2/hour) — see data.ts's compareNetworkTradeCandidatesByPriority for the
 * new 5-level selection order (Trending > Smart Money > Whale > Highest ROI
 * > Highest PnL) that replaced the bucket system as the "pick the best one"
 * gate. Every ceiling here remains a CEILING only, never a floor — a quiet
 * day with fewer real, fully-resolved, quality-eligible exits than that
 * simply posts fewer, same "never fabricate to hit a target" convention as
 * every other feed here.
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
 * tick before picking the single best one — bounded so a backlog spike
 * can't turn one tick into an unbounded evaluation pass. */
const CANDIDATE_FETCH_LIMIT = 30;

/** Same "wake up far more often than the post spacing itself" rationale as
 * ActivityFeedMonitor's own CHECK_INTERVAL_MS. */
const CHECK_INTERVAL_MS = 60_000;

/** "Never publish duplicate trades" via entryId dedup is permanent (see
 * markNetworkTradePosted/filterUnposted in data.ts) — this is the separate,
 * softer "skip duplicate wallets" quality rule (2026-08-05 spec): the same
 * wallet is never the star of two posts back-to-back within this window,
 * even across two genuinely different trades. In-memory/per-process by
 * design (a cosmetic pacing rule, not a correctness guarantee) so it costs
 * no extra query and naturally clears itself on restart. */
const DUPLICATE_WALLET_COOLDOWN_MS = 3 * 60 * 60_000;

export class NetworkTradeFeedMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private nextPostDueAt: number | undefined;
  private postsToday = 0;
  private postsTodayKey: string | undefined;
  private botUsername: string | undefined;
  private recentlyFeaturedWallets = new Map<string, number>();

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
    // real, qualifying, unposted completed trade simply tries again later
    // (per spec: "wait for new qualifying trades instead of fabricating").
    this.scheduleNextCheck(now);
  }

  /** Wallets featured within the last DUPLICATE_WALLET_COOLDOWN_MS — pruned
   * on every check so this map never grows unbounded across a long-running
   * process. */
  private walletsRecentlyFeatured(now: number): Set<string> {
    for (const [wallet, postedAt] of this.recentlyFeaturedWallets) {
      if (now - postedAt >= DUPLICATE_WALLET_COOLDOWN_MS) {
        this.recentlyFeaturedWallets.delete(wallet);
      }
    }
    return new Set(this.recentlyFeaturedWallets.keys());
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

    // Quality gate (2026-08-05 spec: "prefer profitable trades, small losses
    // are acceptable, skip spam, rugs and duplicate wallets") — real losses
    // are never excluded just for being losses; see data.ts's
    // isNetworkTradeCandidateEligible doc comment for the actual bars.
    const qualityEligible = candidates.filter((c) =>
      isNetworkTradeCandidateEligible({
        realizedRoiPercent: c.realizedRoiPercent,
        walletRugExposureRatePct: c.walletRugExposureRatePct,
        walletSybilConfidencePct: c.walletSybilConfidencePct,
      }),
    );
    if (qualityEligible.length === 0) {
      this.deps.logger.info(
        'network trade feed: no real candidate passed the quality filter this tick',
      );
      return false;
    }

    // "Skip duplicate wallets" — a wallet already featured within the
    // cooldown window is excluded outright this tick, never merely
    // deprioritized, so the feed reads as many different real wallets
    // rather than the same one repeatedly.
    const recentWallets = this.walletsRecentlyFeatured(now.getTime());
    const eligible = qualityEligible.filter((c) => !recentWallets.has(c.walletAddress));
    if (eligible.length === 0) {
      this.deps.logger.info(
        'network trade feed: every quality-eligible candidate this tick is from a recently-featured wallet',
      );
      return false;
    }

    await this.resolveBotUsername();

    // Live enrichment (current liquidity/market cap, and 24h volume/h1
    // change for the Trending Tokens priority signal) fetched for every
    // eligible candidate up front so the pick reflects today's numbers, not
    // stale ones. A failed lookup degrades that one candidate to evaluate as
    // if volume/h1-change were 0 — never dropped from consideration just
    // because one live call failed.
    const withEnrichment = await Promise.all(
      eligible.map(async (c) => ({
        c,
        enrichment: await this.deps.marketData.fetchEnrichment(c.mint),
      })),
    );

    // Full 5-level priority order (Trending > Smart Money > Whale > Highest
    // ROI > Highest PnL) — see data.ts's compareNetworkTradeCandidatesByPriority.
    const best = withEnrichment.sort((a, b) =>
      compareNetworkTradeCandidatesByPriority(
        {
          realizedRoiPercent: a.c.realizedRoiPercent,
          realizedPnlUsd: a.c.realizedPnlUsd,
          walletConfidenceScore: a.c.walletConfidenceScore,
          entryAmountSol: a.c.entryAmountSol,
          volume24hUsd: a.enrichment?.volume24hUsd,
          priceChangeH1Percent: a.enrichment?.priceChangeH1Percent,
        },
        {
          realizedRoiPercent: b.c.realizedRoiPercent,
          realizedPnlUsd: b.c.realizedPnlUsd,
          walletConfidenceScore: b.c.walletConfidenceScore,
          entryAmountSol: b.c.entryAmountSol,
          volume24hUsd: b.enrichment?.volume24hUsd,
          priceChangeH1Percent: b.enrichment?.priceChangeH1Percent,
        },
      ),
    )[0]!;

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

    this.recentlyFeaturedWallets.set(best.c.walletAddress, now.getTime());
    this.deps.logger.info(
      { entryId: best.c.entryId, mint: best.c.mint, walletAddress: best.c.walletAddress },
      'network trade feed: posted',
    );
    return true;
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
      entryAmountSol: c.entryAmountSol,
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
