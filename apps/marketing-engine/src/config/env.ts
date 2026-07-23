import { envSchema, loadEnv } from '@nova/shared';

export const marketingEnvSchema = envSchema.pick({
  NODE_ENV: true,
  LOG_LEVEL: true,
  DATABASE_URL: true,
  GEMINI_API_KEY: true,
  OPENROUTER_API_KEY: true,
  OPENROUTER_MODEL: true,
  TELEGRAM_BOT_TOKEN: true,
  TELEGRAM_CHAT_ID: true,
  MARKETING_TELEGRAM_CHANNEL_ID: true,
  MARKETING_AI_IMAGE_ENABLED: true,
  DASHBOARD_URL: true,
  COMMUNITY_URL: true,
  REFERRAL_BASE_URL: true,
});

export function loadMarketingEnv() {
  return loadEnv(marketingEnvSchema);
}

export type MarketingEnv = ReturnType<typeof loadMarketingEnv>;
