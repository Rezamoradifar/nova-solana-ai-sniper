import { InlineKeyboard } from 'grammy';
import { getTelegramTrendEnabled, setTelegramTrendEnabled } from '@nova/shared';
import { withNav } from '../keyboards.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

function isAdmin(deps: ScreenDeps, user: ScreenUser): boolean {
  return user.telegramId !== null && (deps.adminIds?.has(user.telegramId) ?? false);
}

/**
 * Display for the Telegram trend source's current config (TELEGRAM_TREND_*
 * env vars — see packages/shared/src/env.ts) plus its LIVE running state.
 * `TELEGRAM_TREND_SOURCE_ENABLED` gates whether apps/api's worker.ts even
 * constructs the monitor at boot (requires a restart to flip); the Redis
 * flag below (packages/shared/src/telegramTrendToggle.ts) is checked by the
 * running monitor on every poll tick, so this screen's status line reflects
 * the actual runtime state — never a value hardcoded in the UI — and an
 * admin's Pause/Resume tap here takes effect on the very next poll with no
 * restart required, same pattern as the trading kill switch.
 */
export async function renderTrendSettings(
  deps: ScreenDeps,
  user: ScreenUser,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const c = t(lang).common;
  const d = t(lang).trendSettings;
  const { telegramTrend } = deps;

  // envConfigured: whether the monitor was even constructed and its interval
  // started at process boot — false means nothing below matters until an
  // operator flips the env var and restarts nova-api. liveEnabled: the
  // Redis-backed admin pause flag, only meaningful once envConfigured is true
  // and only checkable when deps.redis is actually wired up (always true in
  // production; undefined only in test fixtures that don't need it).
  const envConfigured = telegramTrend.enabled;
  const liveEnabled =
    envConfigured && deps.redis ? await getTelegramTrendEnabled(deps.redis) : envConfigured;
  const reallyRunning = envConfigured && liveEnabled;

  const statusText = !envConfigured
    ? d.statusNotConfigured
    : liveEnabled
      ? c.enabled
      : d.statusPaused;

  const text =
    `${d.title}\n\n` +
    `${d.status(statusText)}\n` +
    `${d.channels(telegramTrend.channels.map((ch) => `t.me/${ch}`).join(', ') || '—')}\n` +
    `${d.minAiScore(telegramTrend.minAiScore)}\n` +
    `${d.pollInterval((telegramTrend.pollIntervalMs / 1000).toFixed(0))}\n\n` +
    `${d.globalNote}` +
    (!envConfigured ? d.notConfiguredNote : '');

  const admin = isAdmin(deps, user);
  const keyboard = new InlineKeyboard();
  if (admin && envConfigured && deps.redis) {
    keyboard.text(reallyRunning ? d.pauseBtn : d.resumeBtn, 'a:trend:toggle').row();
  }

  return { text, keyboard: withNav(keyboard, 'home', lang) };
}

/**
 * Admin-only — the button itself is hidden from non-admins in
 * renderTrendSettings, but callback_data is never trusted, so ownership is
 * re-checked here server-side too (same defense-in-depth convention as
 * every other action handler in this app).
 */
export async function handleToggleTrendMonitor(
  deps: ScreenDeps,
  user: ScreenUser,
): Promise<ScreenResult> {
  if (!isAdmin(deps, user) || !deps.telegramTrend.enabled || !deps.redis) {
    return renderTrendSettings(deps, user);
  }
  const current = await getTelegramTrendEnabled(deps.redis);
  await setTelegramTrendEnabled(deps.redis, !current);
  deps.logger.info(
    { adminId: user.telegramId, enabled: !current },
    'admin toggled telegram trend monitor',
  );
  return renderTrendSettings(deps, user);
}
