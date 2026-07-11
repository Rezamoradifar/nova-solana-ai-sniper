import { navOnly } from '../keyboards.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

/** Read-only display of the Telegram trend source's current global config
 * (TELEGRAM_TREND_* env vars — see packages/shared/src/env.ts). Not editable
 * here: these are operator-controlled, global-for-everyone settings, not a
 * per-user SnipeConfig field — same "global master switch" pattern already
 * used for ENTRY_FILTER_ENABLED and friends, just surfaced for visibility. */
export async function renderTrendSettings(
  deps: ScreenDeps,
  _user: ScreenUser,
): Promise<ScreenResult> {
  const { telegramTrend } = deps;

  const text =
    `⚙️ *Trend Settings*\n\n` +
    `Status: ${telegramTrend.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n` +
    `Channels: ${telegramTrend.channels.map((c) => `t.me/${c}`).join(', ') || '—'}\n` +
    `Min AI Score: *${telegramTrend.minAiScore}*\n` +
    `Poll Interval: *${(telegramTrend.pollIntervalMs / 1000).toFixed(0)}s*\n\n` +
    `_This is a global setting, not per-user._`;

  return { text, keyboard: navOnly('home') };
}
