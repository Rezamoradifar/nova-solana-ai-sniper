/**
 * One-off: generates and publishes exactly ONE real post to the configured
 * marketing channel, then exits — does not start the recurring scheduler.
 * Intended for verifying a new channel/provider config end-to-end (real
 * generation, real dedupe check, real Telegram send) before turning on
 * `startDailyScheduler` in index.ts.
 *
 * Usage: npm run send-test-post -w apps/marketing-engine
 */
import { PrismaClient } from '@prisma/client';
import { createLogger } from '@nova/shared';
import {
  resolveGeminiImageProvider,
  resolveGeminiProvider,
  resolveOpenRouterProvider,
  resolvePrimaryFallbackProvider,
} from '@nova/ai';
import { createBot } from '@nova/telegram-bot';
import { loadMarketingEnv } from '../src/config/env.js';
import { runOnce } from '../src/runner.js';

const logger = createLogger('marketing-engine:send-test-post');

async function main() {
  const env = loadMarketingEnv();

  const chatId = env.MARKETING_TELEGRAM_CHANNEL_ID ?? env.TELEGRAM_CHAT_ID;
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN and MARKETING_TELEGRAM_CHANNEL_ID (or TELEGRAM_CHAT_ID) must be set.',
    );
  }

  const provider = resolvePrimaryFallbackProvider(
    resolveGeminiProvider({ geminiApiKey: env.GEMINI_API_KEY }),
    resolveOpenRouterProvider({
      openrouterApiKey: env.OPENROUTER_API_KEY,
      openrouterModel: env.OPENROUTER_MODEL,
    }),
  );
  if (!provider) {
    throw new Error('GEMINI_API_KEY or OPENROUTER_API_KEY must be set.');
  }

  const prisma = new PrismaClient();
  const bot = createBot(env.TELEGRAM_BOT_TOKEN, logger);
  const imageProvider = resolveGeminiImageProvider({ geminiApiKey: env.GEMINI_API_KEY });

  logger.info(
    { chatId, provider: provider.name, aiImageEnabled: env.MARKETING_AI_IMAGE_ENABLED },
    'sending one test post',
  );

  const result = await runOnce({
    prisma,
    provider,
    bot,
    chatId,
    buttonContext: {
      dashboardUrl: env.DASHBOARD_URL,
      communityUrl: env.COMMUNITY_URL,
      referralUrl: env.REFERRAL_BASE_URL,
    },
    logger,
    aiImageEnabled: env.MARKETING_AI_IMAGE_ENABLED,
    imageProvider,
  });

  await prisma.$disconnect();

  if (!result) {
    throw new Error(
      'runOnce skipped the post (could not generate unique content) — see warnings above.',
    );
  }

  logger.info(result, 'test post published successfully');
   
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main().catch((err) => {
  logger.error({ err }, 'send-test-post failed');
   
  console.error(
    JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  process.exit(1);
});
