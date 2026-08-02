import { PrismaClient } from '@prisma/client';
import { createLogger } from '@nova/shared';
import {
  resolveGeminiImageProvider,
  resolveGeminiProvider,
  resolveOpenRouterProvider,
  resolvePrimaryFallbackProvider,
} from '@nova/ai';
import { createBot } from '@nova/telegram-bot';
import { loadMarketingEnv } from './config/env.js';
import { startDailyScheduler } from './runner.js';
import { MarketDataClient } from './marketData.js';
import { TradeShowcaseMonitor } from './tradeShowcase/monitor.js';
import { BroadcastWorker } from './tradeShowcase/broadcastWorker.js';
import { AdminBroadcastWorker } from './adminBroadcast/adminBroadcastWorker.js';
import { ActivityFeedMonitor } from './activityFeed/monitor.js';
import { EcosystemFeedMonitor } from './ecosystemFeed/monitor.js';
import { createEcosystemConnection } from './discovery/riskScore.js';
import { NetworkTradeFeedMonitor } from './networkTradeFeed/monitor.js';

const logger = createLogger('marketing-engine');

async function main() {
  const env = loadMarketingEnv();

  const broadcastChatId = env.MARKETING_TELEGRAM_CHANNEL_ID ?? env.TELEGRAM_CHAT_ID;
  if (!env.TELEGRAM_BOT_TOKEN || !broadcastChatId) {
    logger.warn(
      'TELEGRAM_BOT_TOKEN/MARKETING_TELEGRAM_CHANNEL_ID (or TELEGRAM_CHAT_ID) not set — marketing-engine is disabled.',
    );
    return;
  }

  // Gemini primary, OpenRouter fallback — deliberately not the general
  // resolveAiProvider priority chain (Anthropic/OpenAI first): this engine
  // is scoped to exactly these two providers, matching the ones actually
  // configured/verified for it. See resolvePrimaryFallbackProvider's own
  // doc comment for the failover behavior.
  const provider = resolvePrimaryFallbackProvider(
    resolveGeminiProvider({ geminiApiKey: env.GEMINI_API_KEY }),
    resolveOpenRouterProvider({
      openrouterApiKey: env.OPENROUTER_API_KEY,
      openrouterModel: env.OPENROUTER_MODEL,
    }),
  );
  if (!provider) {
    logger.warn(
      'GEMINI_API_KEY/OPENROUTER_API_KEY not set — marketing-engine is disabled (no content generator available).',
    );
    return;
  }

  const prisma = new PrismaClient();
  const bot = createBot(env.TELEGRAM_BOT_TOKEN, logger);
  const imageProvider = resolveGeminiImageProvider({ geminiApiKey: env.GEMINI_API_KEY });
  // Shared public-market enrichment (logo/liquidity/market cap/volume/chain)
  // for both the trade showcase and activity feed — see marketData.ts's own
  // isolation doc comment for why this is a standalone client rather than a
  // cross-import of apps/api's live-trading DexScreener client.
  const marketData = new MarketDataClient(env.DEXSCREENER_API_BASE);

  const stop = startDailyScheduler({
    prisma,
    provider,
    bot,
    chatId: broadcastChatId,
    buttonContext: {
      dashboardUrl: env.DASHBOARD_URL,
      communityUrl: env.COMMUNITY_URL,
      referralUrl: env.REFERRAL_BASE_URL,
    },
    logger,
    aiImageEnabled: env.MARKETING_AI_IMAGE_ENABLED,
    imageProvider,
  });

  logger.info('marketing-engine scheduler started');

  // Durable admin-broadcast queue (2026-07-31) — drains one-off announcements
  // enqueued via `npm run durable-broadcast --workspace apps/api -- <file>`
  // (see adminBroadcast/broadcastQueue.ts's enqueueAdminBroadcast). Runs
  // unconditionally (no feature flag): unlike TRADE_SHOWCASE_ENABLED/
  // ACTIVITY_FEED_ENABLED this worker only ever has work when an operator
  // explicitly enqueues something, so there is no "silently starts posting on
  // deploy" risk to gate against.
  const adminBroadcastWorker = new AdminBroadcastWorker({ prisma, bot, logger });
  adminBroadcastWorker.start(env.ADMIN_BROADCAST_WORKER_INTERVAL_MS);
  logger.info(
    { intervalMs: env.ADMIN_BROADCAST_WORKER_INTERVAL_MS },
    'admin broadcast worker started',
  );

  // Daily Trade Showcase (2026-07-27) — separate opt-in feature flag: this
  // posts real trade data (mint addresses, tx signatures, PnL) automatically,
  // so it stays off by default even when the rest of marketing-engine is
  // configured and running. See TRADE_SHOWCASE_ENABLED's own env.ts doc
  // comment.
  let tradeShowcase: TradeShowcaseMonitor | undefined;
  let broadcastWorker: BroadcastWorker | undefined;
  if (env.TRADE_SHOWCASE_ENABLED) {
    tradeShowcase = new TradeShowcaseMonitor({
      prisma,
      bot,
      chatId: broadcastChatId,
      logger,
      maxPostsPerTick: env.TRADE_SHOWCASE_MAX_POSTS_PER_TICK,
      deployedAt: env.TRADE_SHOWCASE_DEPLOYED_AT,
      marketData,
    });
    tradeShowcase.start(env.TRADE_SHOWCASE_POLL_INTERVAL_MS);
    logger.info(
      {
        intervalMs: env.TRADE_SHOWCASE_POLL_INTERVAL_MS,
        deployedAt: env.TRADE_SHOWCASE_DEPLOYED_AT.toISOString(),
      },
      'trade showcase monitor started',
    );

    // Durable broadcast queue (2026-07-29) — TradeShowcaseMonitor is
    // currently the only producer of TradeBroadcast rows (via
    // enqueueTradeBroadcast in tradeShowcase/monitor.ts), so the drain
    // worker only needs to run when showcase posting is itself enabled.
    broadcastWorker = new BroadcastWorker({ prisma, bot, logger });
    broadcastWorker.start(env.BROADCAST_WORKER_INTERVAL_MS);
    logger.info({ intervalMs: env.BROADCAST_WORKER_INTERVAL_MS }, 'broadcast worker started');
  } else {
    logger.info('TRADE_SHOWCASE_ENABLED not set — daily trade showcase is disabled');
  }

  // Real-Data Telegram Activity Feed (2026-07-27) — separate opt-in feature
  // flag, same rationale as TRADE_SHOWCASE_ENABLED above: this posts real
  // token/trade/wallet data automatically, so it stays off by default. Only
  // ever posts real, unposted events (see activityFeed/monitor.ts's own doc
  // comment) — never simulated content, so there is no separate "demo mode"
  // toggle to configure.
  let activityFeed: ActivityFeedMonitor | undefined;
  if (env.ACTIVITY_FEED_ENABLED) {
    activityFeed = new ActivityFeedMonitor({
      prisma,
      bot,
      chatId: broadcastChatId,
      logger,
      minIntervalMinutes: env.ACTIVITY_FEED_MIN_INTERVAL_MINUTES,
      maxIntervalMinutes: env.ACTIVITY_FEED_MAX_INTERVAL_MINUTES,
      maxPostsPerDay: env.ACTIVITY_FEED_MAX_POSTS_PER_DAY,
      deployedAt: env.ACTIVITY_FEED_DEPLOYED_AT,
      marketData,
      trendingMinH1ChangePercent: env.ACTIVITY_FEED_TRENDING_MIN_H1_CHANGE_PERCENT,
    });
    activityFeed.start();
    logger.info(
      {
        minIntervalMinutes: env.ACTIVITY_FEED_MIN_INTERVAL_MINUTES,
        maxIntervalMinutes: env.ACTIVITY_FEED_MAX_INTERVAL_MINUTES,
        maxPostsPerDay: env.ACTIVITY_FEED_MAX_POSTS_PER_DAY,
        deployedAt: env.ACTIVITY_FEED_DEPLOYED_AT.toISOString(),
      },
      'activity feed monitor started',
    );
  } else {
    logger.info('ACTIVITY_FEED_ENABLED not set — real-data activity feed is disabled');
  }

  // Ecosystem Feed (2026-07-31) — separate opt-in feature flag, same
  // rationale as TRADE_SHOWCASE_ENABLED/ACTIVITY_FEED_ENABLED: posts real
  // token/trade data automatically, so it stays off by default. Own
  // read-only Connection (see discovery/riskScore.ts's own doc comment for
  // why it can't share apps/api's live-trading connection) built from the
  // same SOLANA_RPC_URL/HELIUS_API_KEY as live trading, but a fully separate
  // client instance/quota consumer.
  let ecosystemFeed: EcosystemFeedMonitor | undefined;
  if (env.ECOSYSTEM_FEED_ENABLED) {
    const connection = createEcosystemConnection({
      rpcUrl: env.SOLANA_RPC_URL,
      heliusApiKey: env.HELIUS_API_KEY,
    });
    ecosystemFeed = new EcosystemFeedMonitor({
      prisma,
      bot,
      chatId: broadcastChatId,
      logger,
      connection,
      marketData,
      deployedAt: env.ECOSYSTEM_FEED_DEPLOYED_AT,
      telegramChannels: env.ECOSYSTEM_FEED_TELEGRAM_CHANNELS.split(',')
        .map((c) => c.trim())
        .filter(Boolean),
      minLiquidityUsd: env.ECOSYSTEM_FEED_MIN_LIQUIDITY_USD,
      minRiskScore: env.ECOSYSTEM_FEED_MIN_RISK_SCORE,
      minVolumeUsd: env.ECOSYSTEM_FEED_MIN_VOLUME_USD,
      maxHiddenGemMarketCapUsd: env.ECOSYSTEM_FEED_MAX_HIDDEN_GEM_MARKET_CAP_USD,
      maxCandidatesPerTick: env.ECOSYSTEM_FEED_MAX_CANDIDATES_PER_TICK,
      maxPostsPerTick: env.ECOSYSTEM_FEED_MAX_POSTS_PER_TICK,
    });
    ecosystemFeed.start(env.ECOSYSTEM_FEED_POLL_INTERVAL_MS);
    logger.info(
      {
        intervalMs: env.ECOSYSTEM_FEED_POLL_INTERVAL_MS,
        deployedAt: env.ECOSYSTEM_FEED_DEPLOYED_AT.toISOString(),
      },
      'ecosystem feed monitor started',
    );
  } else {
    logger.info('ECOSYSTEM_FEED_ENABLED not set — ecosystem feed is disabled');
  }

  // Network Trade Feed (2026-08-02) — separate opt-in feature flag, same
  // rationale as the feeds above: posts real, other-wallets' completed
  // trades automatically, so it stays off by default. Curated, not a firehose
  // — see monitor.ts's own doc comment for why this posts only the single
  // best-scored unposted trade per tick rather than every real backlog item.
  let networkTradeFeed: NetworkTradeFeedMonitor | undefined;
  if (env.NETWORK_TRADE_FEED_ENABLED) {
    networkTradeFeed = new NetworkTradeFeedMonitor({
      prisma,
      bot,
      chatId: broadcastChatId,
      logger,
      marketData,
      deployedAt: env.NETWORK_TRADE_FEED_DEPLOYED_AT,
      minIntervalMinutes: env.NETWORK_TRADE_FEED_MIN_INTERVAL_MINUTES,
      maxIntervalMinutes: env.NETWORK_TRADE_FEED_MAX_INTERVAL_MINUTES,
      maxPostsPerDay: env.NETWORK_TRADE_FEED_MAX_POSTS_PER_DAY,
    });
    networkTradeFeed.start();
    logger.info(
      {
        minIntervalMinutes: env.NETWORK_TRADE_FEED_MIN_INTERVAL_MINUTES,
        maxIntervalMinutes: env.NETWORK_TRADE_FEED_MAX_INTERVAL_MINUTES,
        maxPostsPerDay: env.NETWORK_TRADE_FEED_MAX_POSTS_PER_DAY,
        deployedAt: env.NETWORK_TRADE_FEED_DEPLOYED_AT.toISOString(),
      },
      'network trade feed monitor started',
    );
  } else {
    logger.info('NETWORK_TRADE_FEED_ENABLED not set — network trade feed is disabled');
  }

  const shutdown = () => {
    logger.info('shutting down marketing-engine');
    stop();
    tradeShowcase?.stop();
    broadcastWorker?.stop();
    adminBroadcastWorker.stop();
    activityFeed?.stop();
    ecosystemFeed?.stop();
    networkTradeFeed?.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'marketing-engine crashed');
  process.exit(1);
});
