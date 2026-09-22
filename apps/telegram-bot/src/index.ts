import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { createLogger } from '@nova/shared';
import { loadBotEnv, parseAdminIds } from './config/env.js';
import { createBot } from './bot.js';
import { registerAdminCommands } from './admin/commands.js';
import { registerUiRouter } from './ui/router.js';
import { pendingSnapshot } from './ui/pending.js';
import { getBotConnection } from './solana/connection.js';

const logger = createLogger('telegram-bot');

async function main() {
  const env = loadBotEnv();

  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.warn(
      'TELEGRAM_BOT_TOKEN not set — telegram-bot is disabled. Set it in .env to enable notifications, admin commands, and marketing posts.',
    );
    // Exit cleanly rather than crash-looping under PM2/Docker when the token is intentionally unset.
    return;
  }

  const prisma = new PrismaClient();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  // ioredis emits 'error' on every connection failure (not just explicit calls);
  // with zero listeners that's an unhandled EventEmitter error, which crashes the
  // whole process on a transient Redis blip rather than just logging and letting
  // ioredis's own reconnect logic (and TradingSafety's fail-closed kill-switch
  // check) handle it.
  redis.on('error', (err) => logger.error({ err }, 'redis client error'));
  const bot = createBot(env.TELEGRAM_BOT_TOKEN, logger);
  const adminIds = parseAdminIds(env.TELEGRAM_ADMIN_IDS);

  if (adminIds.size === 0) {
    logger.warn(
      'TELEGRAM_ADMIN_IDS not set — admin commands are registered but no one is authorized',
    );
  }

  // Private-mode gate - registered before any other handler, so a
  // non-admin sender's update (including /start) never reaches
  // registerAdminCommands/registerUiRouter below at all.
  if (env.TELEGRAM_PRIVATE_MODE) {
    if (adminIds.size === 0) {
      logger.warn(
        'TELEGRAM_PRIVATE_MODE=true but TELEGRAM_ADMIN_IDS is empty — the bot would be unusable by anyone; ignoring TELEGRAM_PRIVATE_MODE',
      );
    } else {
      bot.use(async (ctx, next) => {
        const senderId = ctx.from?.id?.toString();
        if (!senderId || !adminIds.has(senderId)) {
          logger.warn({ senderId }, 'blocked non-admin sender - TELEGRAM_PRIVATE_MODE is on');
          return;
        }
        return next();
      });
    }
  }

  const apiBaseUrl = (env.INTERNAL_API_URL ?? `http://127.0.0.1:${env.API_PORT}`).replace(
    /\/+$/,
    '',
  );
  const telegramTrend = {
    enabled: env.TELEGRAM_TREND_SOURCE_ENABLED,
    channels: env.TELEGRAM_TREND_CHANNELS.split(',')
      .map((c) => c.trim())
      .filter(Boolean),
    minAiScore: env.TELEGRAM_TREND_MIN_AI_SCORE,
    pollIntervalMs: env.TELEGRAM_TREND_POLL_INTERVAL_MS,
    metricsUrl: `${apiBaseUrl}/metrics`,
  };

  const solanaConnection = getBotConnection({
    HELIUS_API_KEY: env.HELIUS_API_KEY,
    SOLANA_RPC_URL: env.SOLANA_RPC_URL,
  });

  const api = { baseUrl: apiBaseUrl, jwtSecret: env.JWT_SECRET };

  registerAdminCommands(bot, prisma, adminIds, logger, redis);
  registerUiRouter(bot, {
    prisma,
    encryptionKey: env.ENCRYPTION_KEY,
    logger,
    telegramTrend,
    solanaConnection,
    api,
    adminIds,
    redis,
  });

  // One-time diagnostic: pending.ts's flow-state Map is in-memory only, so a
  // restart is the only way code changes take effect but also the only chance
  // to see what was still in-flight right before it's wiped. Logs chatId +
  // flow type only — never the flow's payload (e.g. no wallet backup/restore
  // passwords), same restraint as every other log line touching this data.
  const logPendingOnShutdown = (signal: string) => {
    logger.info({ signal, pending: pendingSnapshot() }, 'shutting down, pending flow snapshot');
    void bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => logPendingOnShutdown('SIGINT'));
  process.on('SIGTERM', () => logPendingOnShutdown('SIGTERM'));

  await bot.start({
    onStart: () => logger.info('telegram bot started (long polling)'),
  });
}

main().catch((err) => {
  logger.error({ err }, 'telegram-bot crashed');
  process.exit(1);
});
