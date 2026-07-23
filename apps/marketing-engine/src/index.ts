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
