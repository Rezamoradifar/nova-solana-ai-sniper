import type { Redis } from 'ioredis';

/**
 * Live pause/resume for the Telegram trend channel monitor, Redis-backed so
 * an admin can flip it from Telegram instantly without redeploying or
 * restarting `nova-api` — same pattern as the trading kill switch (see
 * killSwitch.ts). Shared between apps/api (which enforces it on every poll
 * tick) and apps/telegram-bot (which toggles it via the admin-only button on
 * the Trend Settings screen).
 *
 * This is distinct from `TELEGRAM_TREND_SOURCE_ENABLED`: that env var gates
 * whether the monitor is constructed and its polling interval started at
 * process boot at all (requires a restart to change). This flag only
 * pauses/resumes polling within an already-running monitor. Unset defaults
 * to enabled — the monitor runs normally the moment it's started at boot
 * unless an admin has explicitly paused it.
 */
export const TELEGRAM_TREND_ENABLED_REDIS_KEY = 'nova:telegram_trend:enabled';

export async function getTelegramTrendEnabled(redis: Redis): Promise<boolean> {
  const value = await redis.get(TELEGRAM_TREND_ENABLED_REDIS_KEY);
  return value !== '0';
}

export async function setTelegramTrendEnabled(redis: Redis, enabled: boolean): Promise<void> {
  await redis.set(TELEGRAM_TREND_ENABLED_REDIS_KEY, enabled ? '1' : '0');
}
