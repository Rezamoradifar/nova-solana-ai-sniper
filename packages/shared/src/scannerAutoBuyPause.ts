import type { Redis } from 'ioredis';

/**
 * Recurring pump.fun outage follow-up (2026-07-23): a Redis-backed flag, same
 * shape and convention as killSwitch.ts, so it can be set instantly by
 * scannerHealth.ts (on a confirmed total launch-detection outage) and cleared
 * instantly by an admin (the /resumeautobuy Telegram command) without a
 * redeploy or restart. Deliberately separate from KILL_SWITCH: the kill switch
 * is a manual, blanket "stop all new trades" control; this flag is a narrower,
 * automatic safety response specifically to "nothing is detecting new
 * launches right now" — SELL/TP/SL/trailing-stop and existing position
 * monitoring are never gated by this (see safety.ts's checkBeforeOpen, which
 * is buy-only by construction).
 */
export const SCANNER_AUTOBUY_PAUSE_REDIS_KEY = 'nova:trading:scanner_autobuy_paused';
/** Human-readable reason, set alongside the flag so an admin/alert can show
 * why it was paused without needing to cross-reference logs. */
export const SCANNER_AUTOBUY_PAUSE_REASON_REDIS_KEY = 'nova:trading:scanner_autobuy_paused_reason';

export async function getScannerAutoBuyPauseState(redis: Redis): Promise<boolean> {
  const value = await redis.get(SCANNER_AUTOBUY_PAUSE_REDIS_KEY);
  return value === '1';
}

export async function setScannerAutoBuyPauseState(
  redis: Redis,
  active: boolean,
  reason?: string,
): Promise<void> {
  await redis.set(SCANNER_AUTOBUY_PAUSE_REDIS_KEY, active ? '1' : '0');
  if (active && reason) {
    await redis.set(SCANNER_AUTOBUY_PAUSE_REASON_REDIS_KEY, reason);
  } else if (!active) {
    await redis.del(SCANNER_AUTOBUY_PAUSE_REASON_REDIS_KEY);
  }
}

export async function getScannerAutoBuyPauseReason(redis: Redis): Promise<string | undefined> {
  const value = await redis.get(SCANNER_AUTOBUY_PAUSE_REASON_REDIS_KEY);
  return value ?? undefined;
}
