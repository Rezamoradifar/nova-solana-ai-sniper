import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { createLogger } from '@nova/shared';
import { loadBotEnv, parseAdminIds } from './config/env.js';
import { createBot } from './bot.js';
import { registerAdminCommands } from './admin/commands.js';
import { registerUiRouter } from './ui/router.js';
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

  const telegramTrend = {
    enabled: env.TELEGRAM_TREND_SOURCE_ENABLED,
    channels: env.TELEGRAM_TREND_CHANNELS.split(',')
      .map((c) => c.trim())
      .filter(Boolean),
    minAiScore: env.TELEGRAM_TREND_MIN_AI_SCORE,
    pollIntervalMs: env.TELEGRAM_TREND_POLL_INTERVAL_MS,
    metricsUrl: `http://127.0.0.1:${env.API_PORT}/metrics`,
  };

  const solanaConnection = getBotConnection({
    HELIUS_API_KEY: env.HELIUS_API_KEY,
    SOLANA_RPC_URL: env.SOLANA_RPC_URL,
  });

  registerAdminCommands(bot, prisma, adminIds, logger, redis);
  registerUiRouter(bot, {
    prisma,
    encryptionKey: env.ENCRYPTION_KEY,
    logger,
    telegramTrend,
    solanaConnection,
  });

  await bot.start({
    onStart: () => logger.info('telegram bot started (long polling)'),
  });
}

main().catch((err) => {
  logger.error({ err }, 'telegram-bot crashed');
  process.exit(1);
});
