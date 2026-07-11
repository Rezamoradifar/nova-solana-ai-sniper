import { InlineKeyboard } from 'grammy';
import { buildDexScreenerLink } from '../notifications.js';

/**
 * `a:card:*` actions are handled separately from the screen-navigation `s:*`/
 * other `a:*` actions in router.ts — a card is a photo message, so its buttons
 * reply with a new message rather than editing in place (editMessageText fails
 * on a photo message; editing the photo/caption on every tap isn't what "Trade
 * Again"/"Portfolio"/"Share" need anyway).
 */
export function buildBuyCardKeyboard(mint: string): InlineKeyboard {
  return new InlineKeyboard()
    .url('📊 Chart', buildDexScreenerLink(mint))
    .url('🔍 Explorer', `https://solscan.io/token/${mint}`)
    .row()
    .text('💰 Portfolio', 'a:card:portfolio');
}

export function buildSellCardKeyboard(mint: string, positionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .url('📊 Chart', buildDexScreenerLink(mint))
    .url('🔍 Explorer', `https://solscan.io/token/${mint}`)
    .row()
    .text('💰 Portfolio', 'a:card:portfolio')
    .text('🔁 Trade Again', 'a:card:tradeagain')
    .row()
    .text('🔗 Share', `a:card:share:${positionId}`);
}
