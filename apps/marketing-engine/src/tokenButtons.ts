import { buildBuyLink, buildDexScreenerLink } from '@nova/telegram-bot';

export interface ButtonSpec {
  text: string;
  url: string;
}

export interface TokenButtonContext {
  mint: string;
  dex?: string;
  /** Resolved once via bot.api.getMe() and cached by the caller — omitted
   * (Track button dropped) if the bot's own username couldn't be resolved. */
  botUsername?: string;
  websiteUrl?: string;
}

/** Same guard as buttons.ts's isPublicHttpsUrl — Telegram rejects an inline
 * keyboard whose URL isn't a real public https:// address, failing the
 * WHOLE sendPhoto/sendMessage call, not just that one button. A decorative
 * button is never worth failing an entire post over. */
function isPublicHttpsUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Buy/Chart/Track/Scan/Website buttons for an arbitrary token (not a user's
 * own position) — used by the ecosystemFeed's new categories. Returns rows
 * (2 buttons per row, Website alone on its own row) rather than a flat list,
 * for a denser layout than the one-button-per-row convention buttons.ts uses
 * for the general marketing-copy CTAs.
 */
export function buildTokenButtonRows(ctx: TokenButtonContext): ButtonSpec[][] {
  const rows: ButtonSpec[][] = [];

  const topRow: ButtonSpec[] = [
    { text: '⚡ Buy', url: buildBuyLink(ctx.dex ?? '', ctx.mint) },
    { text: '📊 Chart', url: buildDexScreenerLink(ctx.mint) },
  ];
  rows.push(topRow);

  const midRow: ButtonSpec[] = [];
  if (ctx.botUsername) {
    midRow.push({
      text: '🔎 Track',
      url: `https://t.me/${ctx.botUsername}?start=track_${ctx.mint}`,
    });
  }
  midRow.push({ text: '🔍 Scan', url: `https://solscan.io/token/${ctx.mint}` });
  rows.push(midRow);

  if (isPublicHttpsUrl(ctx.websiteUrl)) {
    rows.push([{ text: '🌐 Website', url: ctx.websiteUrl }]);
  }

  return rows;
}
