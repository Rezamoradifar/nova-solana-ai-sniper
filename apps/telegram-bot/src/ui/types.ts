import type { PrismaClient, User } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { InlineKeyboard } from 'grammy';

export type ScreenId =
  | 'home'
  | 'sniper_start'
  | 'sniper_stop'
  | 'wallet'
  | 'dashboard'
  | 'positions'
  | 'trades'
  | 'leaderboard'
  | 'alerts'
  | 'settings'
  | 'profile'
  | 'portfolio'
  | 'referrals'
  | 'help'
  | 'trending'
  | 'arbitrage'
  | 'live_opportunities'
  | 'telegram_trends'
  | 'trend_settings'
  | 'fee_dashboard'
  | 'referral_earnings'
  | 'referral_leaderboard'
  | 'fee_policy_consent';

/** Static config for the Telegram trend source (t.me/trendingssol, t.me/trending)
 * — built once in index.ts from env, same global-not-per-user values the
 * backend (apps/api/src/worker.ts) already uses. metricsUrl points at
 * apps/api's own GET /metrics (live in-memory counters, only reachable over
 * HTTP since telegram-bot is a separate process with no access to that
 * in-memory state). */
export interface TelegramTrendDeps {
  enabled: boolean;
  channels: string[];
  minAiScore: number;
  pollIntervalMs: number;
  metricsUrl: string;
}

export interface ScreenDeps {
  prisma: PrismaClient;
  encryptionKey: string;
  logger: Logger;
  botUsername?: string;
  telegramTrend: TelegramTrendDeps;
}

export interface ScreenResult {
  text: string;
  keyboard: InlineKeyboard;
}

export type ScreenUser = User;
