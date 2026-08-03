import { InlineKeyboard } from 'grammy';
import type { Token } from '@prisma/client';
import { buildBuyLink, buildDexScreenerLink } from '../../notifications.js';
import { escapeMd } from '../format.js';
import { t as tDict, type Locale } from '../../i18n/index.js';

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
export function whyAccepted(t: Token, lang: Locale): string {
  const d = tDict(lang).tokenList;
  const reasons: string[] = [];
  if (t.mintAuthorityRevoked) reasons.push(d.mintRevoked);
  if (t.freezeAuthorityRevoked) reasons.push(d.freezeRevoked);
  if (t.lpBurnedOrLocked) reasons.push(d.lpLocked);
  if (t.liquidityUsd !== null && t.liquidityUsd !== undefined) {
    reasons.push(d.liquidityReason(t.liquidityUsd.toFixed(0)));
  }
  if (t.aiScore !== null && t.aiScore !== undefined) {
    reasons.push(d.aiReason(t.aiScore.toFixed(0)));
  }
  return reasons.length > 0 ? reasons.join(', ') : d.passedThresholds;
}

/** One token's summary block — symbol, source channel (if Telegram-sourced),
 * AI score, liquidity, DEX, risk flags, and why it was accepted. */
export function formatTokenRow(t: Token, lang: Locale): string {
  const d = tDict(lang).tokenList;
  const symbol = escapeMd(t.symbol ?? t.mint.slice(0, 6));
  const name = t.name ? ` — ${escapeMd(t.name)}` : '';
  const sourceLine =
    t.discoverySource === 'TELEGRAM' && t.telegramChannel
      ? d.sourceLine(escapeMd(t.telegramChannel))
      : '';
  const aiLine =
    t.aiScore !== null && t.aiScore !== undefined ? d.aiLine(t.aiScore.toFixed(0)) : '';
  const liquidityLine =
    t.liquidityUsd !== null && t.liquidityUsd !== undefined
      ? d.liquidityLine(t.liquidityUsd.toFixed(0))
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
  const riskLine = riskParts.length > 0 ? d.riskLine(riskParts.join(' | ')) : '';
  const honeypotLine = t.isHoneypotSuspected ? d.honeypotLine : '';

  return (
    `🪙 *${symbol}*${name} — ${escapeMd(t.dex)}${sourceLine}${aiLine}${liquidityLine}${riskLine}${honeypotLine}\n` +
    d.whyAcceptedLine(escapeMd(whyAccepted(t, lang)))
  );
}

/** Chart + Buy row for one token — same link builders the existing trade-card
 * keyboard (cards/keyboards.ts) already uses, so these always match what a
 * user would see on the buy/sell card for the same token. */
export function addTokenButtons(
  keyboard: InlineKeyboard,
  token: Token,
  lang: Locale,
): InlineKeyboard {
  const d = tDict(lang).tokenList;
  return keyboard
    .url(d.chartButton, buildDexScreenerLink(token.mint))
    .url(d.buyButton, buildBuyLink(token.dex, token.mint))
    .row();
}
