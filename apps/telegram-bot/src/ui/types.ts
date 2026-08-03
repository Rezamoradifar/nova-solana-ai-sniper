import type { PrismaClient, User } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { Connection } from '@solana/web3.js';
import type { Redis } from 'ioredis';
import type { InlineKeyboard } from 'grammy';
import type { ApiConfig } from '../api/client.js';

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
  | 'fee_policy_consent'
  | 'language';

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
  /** Known admin Telegram IDs (TELEGRAM_ADMIN_IDS) — gates admin-only screen
   * actions (e.g. the Trend Monitor Enable/Disable button) the same way
   * admin/commands.ts gates admin-only commands. Checked against
   * `user.telegramId`, never trusted from callback_data alone. Optional
   * (undefined in most test fixtures), same convention as solanaConnection/
   * api above — an admin-only action just stays hidden/denied when unset. */
  adminIds?: Set<string>;
  /** Live control-plane for global admin toggles that must take effect on the
   * running nova-api process without a restart — see
   * packages/shared/src/telegramTrendToggle.ts (same pattern as the trading
   * kill switch). Optional, same convention as solanaConnection/api above —
   * screens that need it fall back to the boot-time env snapshot when unset. */
  redis?: Redis;
  /** Minimal single-endpoint connection (see solana/connection.ts) used only
   * for the wallet Deposit screen's balance reads — see refreshWalletBalance
   * in @nova/shared, shared with apps/api's DepositMonitor and
   * refresh-balance route. Optional (undefined in most test fixtures) — the
   * Deposit screen's refresh action just reports "not configured" rather
   * than throwing when unset. */
  solanaConnection?: Connection;
  /** Talks to apps/api's own authenticated HTTP routes for anything that needs
   * the live trading engine (position close/close-all) — see api/client.ts's
   * doc comment on why this reuses PositionManager over HTTP instead of a
   * second sell engine living in this process. Optional (undefined in most
   * test fixtures), same convention as solanaConnection above — screens that
   * need it report "not configured" rather than throwing when unset. */
  api?: ApiConfig;
}

export interface ScreenResult {
  text: string;
  keyboard: InlineKeyboard;
}

export type ScreenUser = User;
