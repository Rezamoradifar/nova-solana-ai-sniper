import { navOnly } from '../keyboards.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

export async function renderHelp(_deps: ScreenDeps, _user: ScreenUser): Promise<ScreenResult> {
  const text =
    `❓ *Help*\n\n` +
    `*Menu*\n` +
    `▶️ Start Sniper — create or resume auto-buy configs\n` +
    `⏹ Stop Sniper — pause all auto-buying\n` +
    `👛 Wallet — create/import/backup/restore wallets\n` +
    `📊 Dashboard — portfolio overview\n` +
    `📈 Positions — open positions, edit TP/SL\n` +
    `💱 Trades — recent trade history\n` +
    `🏆 Leaderboard — top wallets by PnL\n` +
    `🔔 Alerts — recent account activity\n` +
    `⚙️ Settings — edit your snipe config\n` +
    `👤 Profile — your account info\n` +
    `💰 Portfolio — per-wallet PnL breakdown\n` +
    `🔗 Referrals — your invite code and link\n\n` +
    `*Commands*\n` +
    `/start — open the main menu\n\n` +
    `Every feature is free for every user — there are no paid tiers.`;

  return { text, keyboard: navOnly('home') };
}
