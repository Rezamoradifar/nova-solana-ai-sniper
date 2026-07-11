import { navOnly } from '../keyboards.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

interface MetricsSnapshot {
  telegramSignalsReceived: number;
  mintsExtracted: number;
  duplicateRejected: number;
  blacklistRejected: number;
  liquidityZeroRejected: number;
  aiRejected: number;
  qualifiedOpportunities: number;
  executedTrades: number;
  rpcCallsSavedEstimate: number;
}

/** Live pipeline health for the Telegram trend source — reads apps/api's own
 * GET /metrics (an in-memory counter snapshot that only exists inside that
 * process, so it can't be read via Prisma the way every other screen reads
 * its data; this is the one screen in the bot that talks to apps/api over
 * HTTP rather than the database directly). Best-effort: if the API isn't
 * reachable, this shows a clear error rather than crashing the screen. */
export async function renderTelegramTrends(
  deps: ScreenDeps,
  _user: ScreenUser,
): Promise<ScreenResult> {
  const { telegramTrend } = deps;
  const statusLine = telegramTrend.enabled ? '🟢 Enabled' : '🔴 Disabled';

  let metrics: MetricsSnapshot | undefined;
  let fetchError = false;
  try {
    const res = await fetch(telegramTrend.metricsUrl, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      metrics = (await res.json()) as MetricsSnapshot;
    } else {
      fetchError = true;
    }
  } catch (err) {
    deps.logger.warn({ err }, 'telegram trends screen: failed to reach /metrics');
    fetchError = true;
  }

  let text = `📡 *Telegram Trends*\n\nSource status: ${statusLine}\nChannels: ${telegramTrend.channels.map((c) => `t.me/${c}`).join(', ') || '—'}\n\n`;

  if (fetchError || !metrics) {
    text += '⚠️ Could not reach the metrics service right now — try again shortly.';
  } else {
    text +=
      `📥 Signals received: *${metrics.telegramSignalsReceived}*\n` +
      `🪙 Mints extracted: *${metrics.mintsExtracted}*\n` +
      `♻️ Duplicate rejected: *${metrics.duplicateRejected}*\n` +
      `🚫 Blacklist rejected: *${metrics.blacklistRejected}*\n` +
      `💧 Liquidity=0 rejected: *${metrics.liquidityZeroRejected}*\n` +
      `🤖 AI rejected: *${metrics.aiRejected}*\n` +
      `✅ Qualified opportunities: *${metrics.qualifiedOpportunities}*\n` +
      `💰 Executed trades: *${metrics.executedTrades}*\n` +
      `📉 RPC calls saved (est.): *${metrics.rpcCallsSavedEstimate}*`;
  }

  return { text, keyboard: navOnly('home') };
}
