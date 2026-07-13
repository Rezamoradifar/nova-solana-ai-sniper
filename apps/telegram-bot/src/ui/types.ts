import type { PrismaClient, User } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { Connection } from '@solana/web3.js';
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
  /** Minimal single-endpoint connection (see solana/connection.ts) used only
   * for the wallet Deposit screen's balance reads — see refreshWalletBalance
   * in @nova/shared, shared with apps/api's DepositMonitor and
   * refresh-balance route. Optional (undefined in most test fixtures) — the
   * Deposit screen's refresh action just reports "not configured" rather
   * than throwing when unset. */
  solanaConnection?: Connection;
}

export interface ScreenResult {
  text: string;
  keyboard: InlineKeyboard;
}

export type ScreenUser = User;
