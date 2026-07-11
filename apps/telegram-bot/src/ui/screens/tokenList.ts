import { InlineKeyboard } from 'grammy';
import type { Token } from '@prisma/client';
import { buildBuyLink, buildDexScreenerLink } from '../../notifications.js';
import { escapeMd } from '../format.js';

/** Cap on rows per list screen — same convention as positions.ts/trades.ts/alerts.ts,
 * keeping well under Telegram's 4096-char sendMessage limit. */
export const MAX_SHOWN = 8;

/**
 * Short "why this qualified" summary derived purely from the token's own
 * stored risk fields — the only fields that exist for a qualified token.
 * There is no equivalent "why rejected" for a specific token: rejected
 * candidates (liquidity=0, AI score below threshold, blacklisted, duplicate)
 * are deliberately never persisted as Token rows (see worker.ts's
 * handleTelegramSignal) — matches "never show in Launch Feed" for those. The
 * Telegram Trends screen shows aggregate rejection counts instead, which is
 * the closest real "why" available at that level.
 */
export function whyAccepted(t: Token): string {
  const reasons: string[] = [];
  if (t.mintAuthorityRevoked) reasons.push('mint revoked');
  if (t.freezeAuthorityRevoked) reasons.push('freeze revoked');
  if (t.lpBurnedOrLocked) reasons.push('LP locked');
  if (t.liquidityUsd !== null && t.liquidityUsd !== undefined) {
    reasons.push(`$${t.liquidityUsd.toFixed(0)} liquidity`);
  }
  if (t.aiScore !== null && t.aiScore !== undefined) {
    reasons.push(`AI ${t.aiScore.toFixed(0)}/100`);
  }
  return reasons.length > 0 ? reasons.join(', ') : 'passed configured thresholds';
}

/** One token's summary block — symbol, source channel (if Telegram-sourced),
 * AI score, liquidity, DEX, risk flags, and why it was accepted. */
export function formatTokenRow(t: Token): string {
  const symbol = escapeMd(t.symbol ?? t.mint.slice(0, 6));
  const name = t.name ? ` — ${escapeMd(t.name)}` : '';
  const sourceLine =
    t.discoverySource === 'TELEGRAM' && t.telegramChannel
      ? `\n📡 Source: t.me/${escapeMd(t.telegramChannel)}`
      : '';
  const aiLine =
    t.aiScore !== null && t.aiScore !== undefined
      ? `\n🤖 AI Score: *${t.aiScore.toFixed(0)}/100*`
      : '';
  const liquidityLine =
    t.liquidityUsd !== null && t.liquidityUsd !== undefined
      ? `\n💧 Liquidity: *$${t.liquidityUsd.toFixed(0)}*`
      : '';
  const riskParts: string[] = [];
  if (t.mintAuthorityRevoked !== null)
    riskParts.push(`Mint ${t.mintAuthorityRevoked ? '✅' : '⚠️'}`);
  if (t.freezeAuthorityRevoked !== null)
    riskParts.push(`Freeze ${t.freezeAuthorityRevoked ? '✅' : '⚠️'}`);
  if (t.lpBurnedOrLocked !== null) riskParts.push(`LP ${t.lpBurnedOrLocked ? '🔒' : '⚠️'}`);
  if (t.top10HolderPercent !== null && t.top10HolderPercent !== undefined) {
    riskParts.push(`Top10 ${t.top10HolderPercent.toFixed(0)}%`);
  }
  const riskLine = riskParts.length > 0 ? `\n⚠️ Risk: ${riskParts.join(' | ')}` : '';
  const honeypotLine = t.isHoneypotSuspected ? '\n🚨 Honeypot/rug risk flagged' : '';

  return (
    `🪙 *${symbol}*${name} — ${escapeMd(t.dex)}${sourceLine}${aiLine}${liquidityLine}${riskLine}${honeypotLine}\n` +
    `✅ Why accepted: ${escapeMd(whyAccepted(t))}`
  );
}

/** Chart + Buy row for one token — same link builders the existing trade-card
 * keyboard (cards/keyboards.ts) already uses, so these always match what a
 * user would see on the buy/sell card for the same token. */
export function addTokenButtons(keyboard: InlineKeyboard, t: Token): InlineKeyboard {
  return keyboard
    .url('📊 Chart', buildDexScreenerLink(t.mint))
    .url('💰 Buy', buildBuyLink(t.dex, t.mint))
    .row();
}
