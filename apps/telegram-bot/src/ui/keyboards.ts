import { InlineKeyboard, Keyboard } from 'grammy';
import type { ScreenId } from './types.js';
import { t, type Locale } from '../i18n/index.js';

/** Maps each reply-keyboard menu key to the screen it opens — language-independent. */
const SCREEN_BY_MENU_KEY = {
  home: 'home',
  sniperStart: 'sniper_start',
  sniperStop: 'sniper_stop',
  wallet: 'wallet',
  dashboard: 'dashboard',
  positions: 'positions',
  trades: 'trades',
  leaderboard: 'leaderboard',
  alerts: 'alerts',
  settings: 'settings',
  profile: 'profile',
  portfolio: 'portfolio',
  referrals: 'referrals',
  help: 'help',
  trending: 'trending',
  arbitrage: 'arbitrage',
  liveOpportunities: 'live_opportunities',
  telegramTrends: 'telegram_trends',
  trendSettings: 'trend_settings',
  feeDashboard: 'fee_dashboard',
} as const satisfies Record<string, ScreenId>;

type MenuKey = keyof typeof SCREEN_BY_MENU_KEY;

/** Maps every label in BOTH languages to the screen it opens, so a reply-keyboard
 * tap matches regardless of which language keyboard the chat is currently showing
 * (e.g. right after a language switch, before the new keyboard has been sent). */
export const LABEL_TO_SCREEN: Record<string, ScreenId> = (() => {
  const map: Record<string, ScreenId> = {};
  for (const lang of ['en', 'fa'] as const) {
    const labels = t(lang).common.menu;
    for (const key of Object.keys(SCREEN_BY_MENU_KEY) as MenuKey[]) {
      map[labels[key]] = SCREEN_BY_MENU_KEY[key];
    }
  }
  return map;
})();

/** The persistent bottom keyboard — always visible, opens screens by label. */
export function mainMenuKeyboard(lang: Locale): Keyboard {
  const m = t(lang).common.menu;
  return new Keyboard()
    .text(m.home)
    .text(m.sniperStart)
    .row()
    .text(m.sniperStop)
    .text(m.wallet)
    .row()
    .text(m.dashboard)
    .text(m.positions)
    .row()
    .text(m.trades)
    .text(m.leaderboard)
    .row()
    .text(m.alerts)
    .text(m.settings)
    .row()
    .text(m.profile)
    .text(m.portfolio)
    .row()
    .text(m.referrals)
    .text(m.help)
    .row()
    .text(m.trending)
    .text(m.arbitrage)
    .row()
    .text(m.liveOpportunities)
    .text(m.telegramTrends)
    .row()
    .text(m.trendSettings)
    .text(m.feeDashboard)
    .resized();
}

/** Appends the mandatory Back + Home row every non-home screen ends with. */
export function withNav(
  keyboard: InlineKeyboard,
  backScreen: ScreenId,
  lang: Locale,
): InlineKeyboard {
  const d = t(lang);
  return keyboard.row().text(d.common.back, `s:${backScreen}`).text(d.common.menu.home, 's:home');
}

/** A screen with no actions of its own, just the nav row. */
export function navOnly(backScreen: ScreenId, lang: Locale): InlineKeyboard {
  return withNav(new InlineKeyboard(), backScreen, lang);
}

/** The 2-column grid of every section, shown on the Home screen. */
export function homeGrid(lang: Locale): InlineKeyboard {
  const m = t(lang).common.menu;
  return new InlineKeyboard()
    .text(m.sniperStart, 's:sniper_start')
    .text(m.sniperStop, 's:sniper_stop')
    .row()
    .text(m.wallet, 's:wallet')
    .text(m.dashboard, 's:dashboard')
    .row()
    .text(m.positions, 's:positions')
    .text(m.trades, 's:trades')
    .row()
    .text(m.leaderboard, 's:leaderboard')
    .text(m.alerts, 's:alerts')
    .row()
    .text(m.settings, 's:settings')
    .text(m.profile, 's:profile')
    .row()
    .text(m.portfolio, 's:portfolio')
    .text(m.referrals, 's:referrals')
    .row()
    .text(m.help, 's:help')
    .row()
    .text(m.trending, 's:trending')
    .text(m.arbitrage, 's:arbitrage')
    .row()
    .text(m.liveOpportunities, 's:live_opportunities')
    .text(m.telegramTrends, 's:telegram_trends')
    .row()
    .text(m.trendSettings, 's:trend_settings')
    .text(m.feeDashboard, 's:fee_dashboard');
}
