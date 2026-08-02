import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { Bot } from '@nova/telegram-bot';
import { resolveTradePhoto } from '@nova/telegram-bot';
import type { Connection } from '@solana/web3.js';
import type { MarketDataClient, DexScreenerEnrichment } from '../marketData.js';
import { sendBrandedPhotoHtml } from '../telegramSend.js';
import { renderTokenStatCard } from '../visuals/tokenStatCard.js';
import { buildTokenButtonRows } from '../tokenButtons.js';
import { EcosystemTelegramTrendClient } from '../discovery/telegramTrend.js';
import { scoreTokenRisk, computeEcosystemRiskScore } from '../discovery/riskScore.js';
import { toTradeNotificationData } from '../tradeShowcase/monitor.js';
import type { ShowcaseTrade } from '../tradeShowcase/data.js';
import {
  ECOSYSTEM_FEED_TYPES,
  fetchTrendingTokenDbCandidates,
  fetchHighVolumeDbCandidates,
  fetchHiddenGemCandidates,
  fetchSmartMoneyTradeCandidates,
  fetchBiggestWinnerCandidates,
  markEcosystemFeedPosted,
  isMintAlreadyHandledToday,
  mintDedupRefId,
  type EcosystemFeedType,
  type EcosystemDbTokenCandidate,
  type HiddenGemCandidate,
  type SmartMoneyTradeCandidate,
} from './data.js';
import {
  buildTokenStatCardBrief,
  buildTokenCaptionHtml,
  buildSmartMoneyCaptionHtml,
  buildSmartMoneyStatCardBrief,
  buildBiggestWinnerCaptionHtml,
  type TokenCardContext,
} from './format.js';
import { pickNextEcosystemFeedType, type EcosystemFeedTypeBacklog } from './scheduler.js';

/**
 * Ecosystem Feed (2026-07-31) — posts 5 real-data-only ecosystem-wide
 * categories (Trending Tokens, Smart Money Trades, High Volume Tokens,
 * Hidden Gems, Biggest Winners) with a generated stat-card image and
 * Buy/Chart/Track/Scan/Website buttons. New sibling module to activityFeed,
 * not an extension of it (see project plan for why): different send style
 * (HTML+photo+buttons vs. its Markdown/no-buttons path), different cost
 * profile (this one can spend RPC calls on Telegram-discovered candidates),
 * own enable flag/cadence. Zero path into apps/api's live buy/sell
 * execution — see discovery/telegramTrend.ts and discovery/riskScore.ts's
 * own isolation doc comments for the two places that matters most here.
 *
 * Simpler pacing than ActivityFeedMonitor's day-quota/random-interval model:
 * ticks on a fixed interval, posts up to maxPostsPerTick events per tick,
 * same "spread across the day, never flood" rationale as
 * TRADE_SHOWCASE_MAX_POSTS_PER_TICK. A tick with no real, verified backlog
 * simply posts nothing — never fabricates content to fill a gap.
 */

export interface EcosystemFeedMonitorDeps {
  prisma: PrismaClient;
  bot: Bot;
  chatId: string;
  logger: Logger;
  /** Read-only RPC connection for discovery/riskScore.ts — see that module's
   * own doc comment on why this is a separate, standalone Connection. */
  connection: Connection;
  marketData: MarketDataClient;
  /** Fixed cutoff — see ECOSYSTEM_FEED_DEPLOYED_AT's own env.ts doc comment. */
  deployedAt: Date;
  telegramChannels: string[];
  minLiquidityUsd: number;
  minRiskScore: number;
  minVolumeUsd: number;
  maxHiddenGemMarketCapUsd: number;
  maxCandidatesPerTick: number;
  maxPostsPerTick: number;
  websiteUrl?: string;
}

const CANDIDATE_FETCH_LIMIT = 5;

/** A token candidate that's already cleared its category's real
 * verification gate (liquidity + risk score) and has real, live enrichment
 * data to show — shared shape for the Trending Tokens and High Volume
 * Tokens categories, which differ only in their source pool/gate, not in
 * how the resulting post looks. */
interface VerifiedTokenPost {
  /** Dedup refId — either `${tokenId}:${dayKey}` (DB-sourced) or
   * `${mint}:${dayKey}` (Telegram-discovered, see data.ts's own doc comment). */
  id: string;
  mint: string;
  name: string | undefined;
  symbol: string | undefined;
  dex: string | undefined;
  enrichment: DexScreenerEnrichment;
  riskScore: number;
}

function requireFirst<T>(arr: T[], feedType: EcosystemFeedType): T {
  const first = arr[0];
  if (!first) throw new Error(`ecosystem feed: ${feedType} chosen with empty candidate list`);
  return first;
}

/** Pure — computes a DB-sourced candidate's risk score entirely from fields
 * already stored on its Token row (zero RPC cost), or `undefined` if those
 * fields were never populated (e.g. a token that hasn't finished its real
 * evaluation yet) — such a candidate is simply left off this tick's post
 * rather than scored with guessed defaults. */
function dbCandidateRiskScore(
  c: Pick<
    EcosystemDbTokenCandidate,
    'mintAuthorityRevoked' | 'freezeAuthorityRevoked' | 'top10HolderPercent'
  >,
  liquidityUsd: number,
): number | undefined {
  if (c.mintAuthorityRevoked === undefined || c.freezeAuthorityRevoked === undefined)
    return undefined;
  return computeEcosystemRiskScore({
    mintAuthorityRevoked: c.mintAuthorityRevoked,
    freezeAuthorityRevoked: c.freezeAuthorityRevoked,
    top10HolderPercent: c.top10HolderPercent ?? 0,
    liquidityUsd,
  });
}

export class EcosystemFeedMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private lastPostedType: EcosystemFeedType | undefined;
  private botUsername: string | undefined;
  private readonly telegramClient = new EcosystemTelegramTrendClient();
  private readonly lastSeenMessageId = new Map<string, number>();

  constructor(private readonly deps: EcosystemFeedMonitorDeps) {}

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
      await this.resolveBotUsername();
      for (let i = 0; i < this.deps.maxPostsPerTick; i++) {
        const posted = await this.postOneEvent(new Date());
        if (!posted) break;
      }
    } catch (err) {
      this.deps.logger.error({ err }, 'ecosystem feed: tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private async resolveBotUsername(): Promise<void> {
    if (this.botUsername) return;
    try {
      const me = await this.deps.bot.api.getMe();
      this.botUsername = me.username;
    } catch (err) {
      this.deps.logger.warn(
        { err },
        'ecosystem feed: failed to resolve bot username for Track button',
      );
    }
  }

  /** Rolling pool of bot-detected tokens, each re-checked against a live
   * DexScreener liquidity floor and a risk score computed at zero RPC cost
   * from the token's own already-stored authority/holder flags (see
   * dbCandidateRiskScore). A candidate that doesn't currently clear either
   * bar is left unposted and re-checked on a later tick, within the same
   * day-bucket window — never posted anyway. */
  private async getDbVerifiedPosts(
    candidates: EcosystemDbTokenCandidate[],
  ): Promise<VerifiedTokenPost[]> {
    const checked = await Promise.all(
      candidates.map(async (c) => ({
        c,
        enrichment: await this.deps.marketData.fetchEnrichment(c.mint),
      })),
    );
    const posts: VerifiedTokenPost[] = [];
    for (const { c, enrichment } of checked) {
      if (!enrichment) continue;
      const liquidityUsd = enrichment.liquidityUsd ?? c.liquidityUsd;
      if (liquidityUsd === undefined || liquidityUsd < this.deps.minLiquidityUsd) continue;
      const riskScore = dbCandidateRiskScore(c, liquidityUsd);
      if (riskScore === undefined || riskScore < this.deps.minRiskScore) continue;
      posts.push({
        id: c.id,
        mint: c.mint,
        name: c.name,
        symbol: c.symbol,
        dex: c.dex,
        enrichment,
        riskScore,
      });
    }
    return posts;
  }

  /** Polls the configured public Telegram channels for newly-seen messages
   * (see discovery/telegramTrend.ts), extracts candidate mints, and verifies
   * each one cheapest-first: a real DexScreener liquidity check before the
   * RPC-cost risk score — capped at maxCandidatesPerTick RPC-scored
   * candidates per tick, since the risk scorer's Connection shares provider
   * quota with live trading. The Telegram message's own text is never used
   * for anything beyond mint extraction — every field in the resulting post
   * comes from the real DexScreener/RPC checks below. */
  private async discoverVerifiedTrendingPosts(now: Date): Promise<VerifiedTokenPost[]> {
    const posts: VerifiedTokenPost[] = [];
    let scored = 0;

    for (const channel of this.deps.telegramChannels) {
      if (scored >= this.deps.maxCandidatesPerTick) break;

      let messages;
      try {
        messages = await this.telegramClient.fetchMessages(
          channel,
          this.lastSeenMessageId.get(channel),
        );
      } catch (err) {
        this.deps.logger.warn({ err, channel }, 'ecosystem feed: telegram channel fetch failed');
        continue;
      }
      if (messages.length > 0) {
        this.lastSeenMessageId.set(channel, Math.max(...messages.map((m) => m.messageId)));
      }

      const mints = [...new Set(messages.flatMap((m) => m.mints))];
      for (const mint of mints) {
        if (scored >= this.deps.maxCandidatesPerTick) break;
        const alreadyHandled = await isMintAlreadyHandledToday(
          this.deps.prisma,
          ECOSYSTEM_FEED_TYPES.TRENDING_TOKEN,
          mint,
          now,
        );
        if (alreadyHandled) continue;
        scored += 1;

        const enrichment = await this.deps.marketData.fetchEnrichment(mint);
        if (!enrichment || (enrichment.liquidityUsd ?? 0) < this.deps.minLiquidityUsd) continue;

        const risk = await scoreTokenRisk(this.deps.connection, mint, enrichment.liquidityUsd ?? 0);
        if (!risk || risk.score < this.deps.minRiskScore) continue;

        posts.push({
          id: mintDedupRefId(mint, now),
          mint,
          name: undefined,
          symbol: undefined,
          dex: undefined,
          enrichment,
          riskScore: risk.score,
        });
      }
    }
    return posts;
  }

  private async postOneEvent(now: Date): Promise<boolean> {
    const { prisma } = this.deps;

    const [dbTrendingCandidates, dbHighVolumeCandidates, hiddenGems, smartMoney, biggestWinners] =
      await Promise.all([
        fetchTrendingTokenDbCandidates(prisma, CANDIDATE_FETCH_LIMIT, this.deps.deployedAt, now),
        fetchHighVolumeDbCandidates(prisma, CANDIDATE_FETCH_LIMIT, this.deps.deployedAt, now),
        fetchHiddenGemCandidates(
          prisma,
          CANDIDATE_FETCH_LIMIT,
          this.deps.deployedAt,
          now,
          this.deps.maxHiddenGemMarketCapUsd,
        ),
        fetchSmartMoneyTradeCandidates(prisma, CANDIDATE_FETCH_LIMIT, this.deps.deployedAt),
        fetchBiggestWinnerCandidates(prisma, CANDIDATE_FETCH_LIMIT, this.deps.deployedAt),
      ]);

    const [dbTrending, discoveredTrending, highVolumeAll] = await Promise.all([
      this.getDbVerifiedPosts(dbTrendingCandidates),
      this.discoverVerifiedTrendingPosts(now),
      this.getDbVerifiedPosts(dbHighVolumeCandidates),
    ]);
    const trendingPosts = [...dbTrending, ...discoveredTrending];
    const highVolumePosts = highVolumeAll.filter(
      (p) => (p.enrichment.volume24hUsd ?? 0) >= this.deps.minVolumeUsd,
    );

    const backlogs: EcosystemFeedTypeBacklog[] = [
      { type: ECOSYSTEM_FEED_TYPES.TRENDING_TOKEN, count: trendingPosts.length },
      { type: ECOSYSTEM_FEED_TYPES.HIGH_VOLUME_TOKEN, count: highVolumePosts.length },
      { type: ECOSYSTEM_FEED_TYPES.HIDDEN_GEM, count: hiddenGems.length },
      { type: ECOSYSTEM_FEED_TYPES.SMART_MONEY_TRADE, count: smartMoney.length },
      { type: ECOSYSTEM_FEED_TYPES.BIGGEST_WINNER, count: biggestWinners.length },
    ];

    const chosen = pickNextEcosystemFeedType(backlogs, this.lastPostedType);
    if (!chosen) {
      this.deps.logger.info('ecosystem feed: no real, verified backlog this tick — skipping');
      return false;
    }

    try {
      switch (chosen) {
        case ECOSYSTEM_FEED_TYPES.TRENDING_TOKEN: {
          const c = requireFirst(trendingPosts, chosen);
          await this.postVerifiedTokenCard(c, '🔥 TRENDING TOKEN', '🔥 <b>TRENDING TOKEN</b>');
          await markEcosystemFeedPosted(prisma, ECOSYSTEM_FEED_TYPES.TRENDING_TOKEN, c.id);
          break;
        }
        case ECOSYSTEM_FEED_TYPES.HIGH_VOLUME_TOKEN: {
          const c = requireFirst(highVolumePosts, chosen);
          await this.postVerifiedTokenCard(
            c,
            '📈 HIGH VOLUME TOKEN',
            '📈 <b>HIGH VOLUME TOKEN</b>',
          );
          await markEcosystemFeedPosted(prisma, ECOSYSTEM_FEED_TYPES.HIGH_VOLUME_TOKEN, c.id);
          break;
        }
        case ECOSYSTEM_FEED_TYPES.HIDDEN_GEM: {
          const c = requireFirst(hiddenGems, chosen);
          await this.postHiddenGem(c);
          await markEcosystemFeedPosted(prisma, ECOSYSTEM_FEED_TYPES.HIDDEN_GEM, c.id);
          break;
        }
        case ECOSYSTEM_FEED_TYPES.SMART_MONEY_TRADE: {
          const c = requireFirst(smartMoney, chosen);
          await this.postSmartMoney(c);
          await markEcosystemFeedPosted(prisma, ECOSYSTEM_FEED_TYPES.SMART_MONEY_TRADE, c.id);
          break;
        }
        case ECOSYSTEM_FEED_TYPES.BIGGEST_WINNER: {
          const t = requireFirst(biggestWinners, chosen);
          await this.postBiggestWinner(t);
          await markEcosystemFeedPosted(prisma, ECOSYSTEM_FEED_TYPES.BIGGEST_WINNER, t.positionId);
          break;
        }
      }
    } catch (err) {
      // Real event stays unposted (no dedup row written on failure) —
      // retried next tick rather than silently dropped, same convention as
      // ActivityFeedMonitor/TradeShowcaseMonitor.
      this.deps.logger.error(
        { err, feedType: chosen },
        'ecosystem feed: failed to post — will retry later',
      );
      return false;
    }

    this.lastPostedType = chosen;
    this.deps.logger.info({ feedType: chosen }, 'ecosystem feed: posted');
    return true;
  }

  private async sendTokenCard(
    ctx: TokenCardContext,
    headlineHtml: string,
    dex: string | undefined,
  ): Promise<void> {
    const brief = buildTokenStatCardBrief(ctx);
    const image = await renderTokenStatCard(brief);
    const caption = buildTokenCaptionHtml(ctx, headlineHtml, new Date());
    const buttons = buildTokenButtonRows({
      mint: ctx.mint,
      dex,
      botUsername: this.botUsername,
      websiteUrl: this.deps.websiteUrl,
    });
    await sendBrandedPhotoHtml(this.deps.bot, this.deps.chatId, image, caption, buttons);
  }

  private async postVerifiedTokenCard(
    c: VerifiedTokenPost,
    categoryTag: string,
    headlineHtml: string,
  ): Promise<void> {
    await this.sendTokenCard(
      {
        mint: c.mint,
        name: c.name,
        symbol: c.symbol,
        categoryTag,
        changePercent: c.enrichment.priceChangeH1Percent,
        marketCapUsd: c.enrichment.marketCapUsd,
        liquidityUsd: c.enrichment.liquidityUsd,
        volumeUsd: c.enrichment.volume24hUsd,
        riskScore: c.riskScore,
      },
      headlineHtml,
      c.dex,
    );
  }

  private async postHiddenGem(c: HiddenGemCandidate): Promise<void> {
    const riskScore = dbCandidateRiskScore(c, c.liquidityUsd);
    await this.sendTokenCard(
      {
        mint: c.mint,
        name: c.name,
        symbol: c.symbol,
        categoryTag: '💎 HIDDEN GEM',
        changePercent: undefined,
        marketCapUsd: c.marketCapUsd,
        liquidityUsd: c.liquidityUsd,
        volumeUsd: undefined,
        riskScore: riskScore ?? c.aiScore,
      },
      '💎 <b>HIDDEN GEM</b>',
      c.dex,
    );
  }

  private async postSmartMoney(c: SmartMoneyTradeCandidate): Promise<void> {
    const enrichment = await this.deps.marketData.fetchEnrichment(c.mint);
    const cardCtx = {
      marketCapUsd: enrichment?.marketCapUsd,
      liquidityUsd: enrichment?.liquidityUsd,
      volumeUsd: enrichment?.volume24hUsd,
      changePercent: enrichment?.priceChangeH1Percent,
    };
    const brief = buildSmartMoneyStatCardBrief(c, cardCtx);
    const image = await renderTokenStatCard(brief);
    const caption = buildSmartMoneyCaptionHtml(c, cardCtx);
    const buttons = buildTokenButtonRows({
      mint: c.mint,
      botUsername: this.botUsername,
      websiteUrl: this.deps.websiteUrl,
    });
    await sendBrandedPhotoHtml(this.deps.bot, this.deps.chatId, image, caption, buttons);
  }

  /** Reuses @nova/telegram-bot's resolveTradePhoto (the real GeckoTerminal-
   * chart photo already built for a closed position) instead of the new
   * tokenStatCard template — this category has a real position to chart,
   * unlike the other 4. */
  private async postBiggestWinner(t: ShowcaseTrade): Promise<void> {
    const enrichment = await this.deps.marketData.fetchEnrichment(t.mint);
    const notification = toTradeNotificationData(t, enrichment);
    const photo = await resolveTradePhoto(notification);
    const caption = buildBiggestWinnerCaptionHtml(t);
    const buttons = buildTokenButtonRows({
      mint: t.mint,
      dex: t.dex,
      botUsername: this.botUsername,
      websiteUrl: this.deps.websiteUrl,
    });
    await sendBrandedPhotoHtml(this.deps.bot, this.deps.chatId, photo, caption, buttons);
  }
}
