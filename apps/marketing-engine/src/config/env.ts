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
  TRADE_SHOWCASE_ENABLED: true,
  TRADE_SHOWCASE_POLL_INTERVAL_MS: true,
  TRADE_SHOWCASE_MAX_POSTS_PER_TICK: true,
  TRADE_SHOWCASE_DEPLOYED_AT: true,
  ACTIVITY_FEED_ENABLED: true,
  ACTIVITY_FEED_MIN_INTERVAL_MINUTES: true,
  ACTIVITY_FEED_MAX_INTERVAL_MINUTES: true,
  ACTIVITY_FEED_MAX_POSTS_PER_DAY: true,
  ACTIVITY_FEED_DEPLOYED_AT: true,
  ACTIVITY_FEED_TRENDING_MIN_H1_CHANGE_PERCENT: true,
  DEXSCREENER_API_BASE: true,
});

export function loadMarketingEnv() {
  return loadEnv(marketingEnvSchema);
}

export type MarketingEnv = ReturnType<typeof loadMarketingEnv>;
