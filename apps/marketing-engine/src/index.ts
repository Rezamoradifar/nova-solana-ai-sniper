import { PrismaClient } from '@prisma/client';
import { createLogger } from '@nova/shared';
import { hasAnyAiProvider, resolveAiProvider } from '@nova/ai';
import { createBot } from '@nova/telegram-bot';
import { loadMarketingEnv } from './config/env.js';
import { startDailyScheduler } from './runner.js';

const logger = createLogger('marketing-engine');

async function main() {
  const env = loadMarketingEnv();

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    logger.warn(
      'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — marketing-engine is disabled. Set both in .env to enable scheduled posts.',
    );
    return;
  }

  const aiEnabled = hasAnyAiProvider({
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
  });
  if (!aiEnabled) {
    logger.warn(
      'ANTHROPIC_API_KEY/OPENAI_API_KEY not set — marketing-engine is disabled (no content generator available).',
    );
    return;
  }

  const provider = resolveAiProvider({
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
  });
  const prisma = new PrismaClient();
  const bot = createBot(env.TELEGRAM_BOT_TOKEN, logger);

  const stop = startDailyScheduler({
    prisma,
    provider,
    bot,
    chatId: env.TELEGRAM_CHAT_ID,
    buttonContext: {
      dashboardUrl: env.DASHBOARD_URL,
      communityUrl: env.COMMUNITY_URL,
      referralUrl: env.REFERRAL_BASE_URL,
    },
    logger,
  });

  logger.info('marketing-engine scheduler started');

  const shutdown = () => {
    logger.info('shutting down marketing-engine');
    stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'marketing-engine crashed');
  process.exit(1);
});
