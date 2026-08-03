import { getTelegramTrendEnabled } from '@nova/shared';
import { navOnly } from '../keyboards.js';
import { getLocale, t } from '../../i18n/index.js';
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
  user: ScreenUser,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const c = t(lang).common;
  const d = t(lang).telegramTrends;
  const { telegramTrend } = deps;
  // Same live-state check as trendSettings.ts's status line — this screen
  // must never show a boot-time env snapshot as if it were current, since an
  // admin can pause/resume the monitor live via Redis without a restart.
  const liveEnabled =
    telegramTrend.enabled && deps.redis
      ? await getTelegramTrendEnabled(deps.redis)
      : telegramTrend.enabled;
  const statusLine = liveEnabled ? c.enabled : c.disabled;

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

  let text = d.header(statusLine, telegramTrend.channels.map((c) => `t.me/${c}`).join(', ') || '—');

  if (fetchError || !metrics) {
    text += d.fetchError;
  } else {
    text +=
      `${d.signalsReceived(metrics.telegramSignalsReceived)}\n` +
      `${d.mintsExtracted(metrics.mintsExtracted)}\n` +
      `${d.duplicateRejected(metrics.duplicateRejected)}\n` +
      `${d.blacklistRejected(metrics.blacklistRejected)}\n` +
      `${d.liquidityZeroRejected(metrics.liquidityZeroRejected)}\n` +
      `${d.aiRejected(metrics.aiRejected)}\n` +
      `${d.qualifiedOpportunities(metrics.qualifiedOpportunities)}\n` +
      `${d.executedTrades(metrics.executedTrades)}\n` +
      `${d.rpcSaved(metrics.rpcCallsSavedEstimate)}`;
  }

  return { text, keyboard: navOnly('home', lang) };
}
