import { envSchema, loadEnv } from '@nova/shared';

export const marketingEnvSchema = envSchema.pick({
  NODE_ENV: true,
  LOG_LEVEL: true,
  DATABASE_URL: true,
  ANTHROPIC_API_KEY: true,
  OPENAI_API_KEY: true,
  TELEGRAM_BOT_TOKEN: true,
  TELEGRAM_CHAT_ID: true,
  DASHBOARD_URL: true,
  COMMUNITY_URL: true,
  REFERRAL_BASE_URL: true,
});

export function loadMarketingEnv() {
  return loadEnv(marketingEnvSchema);
}

export type MarketingEnv = ReturnType<typeof loadMarketingEnv>;
