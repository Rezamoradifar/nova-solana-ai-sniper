import type { Redis } from 'ioredis';

/**
 * The real emergency stop: a Redis-backed flag so it can be flipped instantly
 * (e.g. via the Telegram /killswitch admin command) without redeploying or
 * restarting the API process. Shared between apps/api (which enforces it) and
 * apps/telegram-bot (which toggles it) so the key name/value convention only
 * lives in one place.
 */
export const KILL_SWITCH_REDIS_KEY = 'nova:trading:kill_switch';

export async function getKillSwitchState(redis: Redis): Promise<boolean> {
  const value = await redis.get(KILL_SWITCH_REDIS_KEY);
  return value === '1';
}

export async function setKillSwitchState(redis: Redis, active: boolean): Promise<void> {
  await redis.set(KILL_SWITCH_REDIS_KEY, active ? '1' : '0');
}
