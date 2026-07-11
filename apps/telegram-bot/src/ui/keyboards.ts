import { InlineKeyboard, Keyboard } from 'grammy';
import type { ScreenId } from './types.js';

export const MENU_LABELS = {
  home: '🏠 Home',
  sniperStart: '▶️ Start Sniper',
  sniperStop: '⏹ Stop Sniper',
  wallet: '👛 Wallet',
  dashboard: '📊 Dashboard',
  positions: '📈 Positions',
  trades: '💱 Trades',
  leaderboard: '🏆 Leaderboard',
  alerts: '🔔 Alerts',
  settings: '⚙️ Settings',
  profile: '👤 Profile',
  portfolio: '💰 Portfolio',
  referrals: '🔗 Referrals',
  help: '❓ Help',
  trending: '🚀 Trending',
  arbitrage: '🚧 Arbitrage',
  liveOpportunities: '🔥 Live Opportunities',
  telegramTrends: '📡 Telegram Trends',
  trendSettings: '⚙️ Trend Settings',
  feeDashboard: '💸 Fees & Earnings',
} as const;

/** Maps each reply-keyboard label to the screen it opens. */
export const LABEL_TO_SCREEN: Record<string, ScreenId> = {
  [MENU_LABELS.home]: 'home',
  [MENU_LABELS.sniperStart]: 'sniper_start',
  [MENU_LABELS.sniperStop]: 'sniper_stop',
  [MENU_LABELS.wallet]: 'wallet',
  [MENU_LABELS.dashboard]: 'dashboard',
  [MENU_LABELS.positions]: 'positions',
  [MENU_LABELS.trades]: 'trades',
  [MENU_LABELS.leaderboard]: 'leaderboard',
  [MENU_LABELS.alerts]: 'alerts',
  [MENU_LABELS.settings]: 'settings',
  [MENU_LABELS.profile]: 'profile',
  [MENU_LABELS.portfolio]: 'portfolio',
  [MENU_LABELS.referrals]: 'referrals',
  [MENU_LABELS.help]: 'help',
  [MENU_LABELS.trending]: 'trending',
  [MENU_LABELS.arbitrage]: 'arbitrage',
  [MENU_LABELS.liveOpportunities]: 'live_opportunities',
  [MENU_LABELS.telegramTrends]: 'telegram_trends',
  [MENU_LABELS.trendSettings]: 'trend_settings',
  [MENU_LABELS.feeDashboard]: 'fee_dashboard',
};

/** The persistent bottom keyboard — always visible, opens screens by label. */
export function mainMenuKeyboard(): Keyboard {
  return new Keyboard()
    .text(MENU_LABELS.home)
    .text(MENU_LABELS.sniperStart)
    .row()
    .text(MENU_LABELS.sniperStop)
    .text(MENU_LABELS.wallet)
    .row()
    .text(MENU_LABELS.dashboard)
    .text(MENU_LABELS.positions)
    .row()
    .text(MENU_LABELS.trades)
    .text(MENU_LABELS.leaderboard)
    .row()
    .text(MENU_LABELS.alerts)
    .text(MENU_LABELS.settings)
    .row()
    .text(MENU_LABELS.profile)
    .text(MENU_LABELS.portfolio)
    .row()
    .text(MENU_LABELS.referrals)
    .text(MENU_LABELS.help)
    .row()
    .text(MENU_LABELS.trending)
    .text(MENU_LABELS.arbitrage)
    .row()
    .text(MENU_LABELS.liveOpportunities)
    .text(MENU_LABELS.telegramTrends)
    .row()
    .text(MENU_LABELS.trendSettings)
    .text(MENU_LABELS.feeDashboard)
    .resized();
}

/** Appends the mandatory Back + Home row every non-home screen ends with. */
export function withNav(keyboard: InlineKeyboard, backScreen: ScreenId): InlineKeyboard {
  return keyboard.row().text('⬅️ Back', `s:${backScreen}`).text('🏠 Home', 's:home');
}

/** A screen with no actions of its own, just the nav row. */
export function navOnly(backScreen: ScreenId): InlineKeyboard {
  return withNav(new InlineKeyboard(), backScreen);
}

/** The 2-column grid of every section, shown on the Home screen. */
export function homeGrid(): InlineKeyboard {
  return new InlineKeyboard()
    .text(MENU_LABELS.sniperStart, 's:sniper_start')
    .text(MENU_LABELS.sniperStop, 's:sniper_stop')
    .row()
    .text(MENU_LABELS.wallet, 's:wallet')
    .text(MENU_LABELS.dashboard, 's:dashboard')
    .row()
    .text(MENU_LABELS.positions, 's:positions')
    .text(MENU_LABELS.trades, 's:trades')
    .row()
    .text(MENU_LABELS.leaderboard, 's:leaderboard')
    .text(MENU_LABELS.alerts, 's:alerts')
    .row()
    .text(MENU_LABELS.settings, 's:settings')
    .text(MENU_LABELS.profile, 's:profile')
    .row()
    .text(MENU_LABELS.portfolio, 's:portfolio')
    .text(MENU_LABELS.referrals, 's:referrals')
    .row()
    .text(MENU_LABELS.help, 's:help')
    .row()
    .text(MENU_LABELS.trending, 's:trending')
    .text(MENU_LABELS.arbitrage, 's:arbitrage')
    .row()
    .text(MENU_LABELS.liveOpportunities, 's:live_opportunities')
    .text(MENU_LABELS.telegramTrends, 's:telegram_trends')
    .row()
    .text(MENU_LABELS.trendSettings, 's:trend_settings')
    .text(MENU_LABELS.feeDashboard, 's:fee_dashboard');
}
