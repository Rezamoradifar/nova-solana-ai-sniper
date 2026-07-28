import type { Bot } from '@nova/telegram-bot';

export interface BrandedSendOptions {
  /** Sent as a photo with `text` as caption when present — the "token logo"
   * requirement (2026-07-28 premium activity feed spec, requirement #9). */
  logoUrl?: string;
  /** When no logo is available, an un-suppressed link preview at this URL
   * lets Telegram render DexScreener's own server-rendered chart image
   * inline instead — same trick tradeShowcase's per-trade post already used
   * (see its own doc comment) rather than showing a bare text message. */
  linkPreviewUrl?: string;
}

/** Telegram's hard limit on a photo caption — a message this long can't be
 * sent as a photo at all, regardless of whether a logo is available. */
const PHOTO_CAPTION_LIMIT = 1024;

/** One shared send path for every activity/showcase post — routes to
 * sendPhoto when a real logo URL is available, otherwise sendMessage with an
 * optional live link preview. Never fabricates a logo: a message with no
 * `logoUrl` simply has no photo, per the same "omit rather than invent"
 * convention as the rest of this feed. */
export async function sendBrandedMessage(
  bot: Bot,
  chatId: string,
  text: string,
  opts: BrandedSendOptions = {},
): Promise<{ message_id: number }> {
  if (opts.logoUrl && text.length <= PHOTO_CAPTION_LIMIT) {
    return bot.api.sendPhoto(chatId, opts.logoUrl, { caption: text, parse_mode: 'Markdown' });
  }
  return bot.api.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...(opts.linkPreviewUrl ? { link_preview_options: { url: opts.linkPreviewUrl } } : {}),
  });
}
