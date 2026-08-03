import { InlineKeyboard, InputFile } from 'grammy';
import type { Bot, SendableTradePhoto } from '@nova/telegram-bot';
import type { ButtonSpec } from './tokenButtons.js';

function isFileId(photo: SendableTradePhoto): photo is { fileId: string } {
  return 'fileId' in photo;
}

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

function buildInlineKeyboard(rows: ButtonSpec[][]): InlineKeyboard | undefined {
  const nonEmptyRows = rows.filter((row) => row.length > 0);
  if (nonEmptyRows.length === 0) return undefined;
  const keyboard = new InlineKeyboard();
  nonEmptyRows.forEach((row, i) => {
    for (const button of row) {
      keyboard.url(button.text, button.url);
    }
    if (i < nonEmptyRows.length - 1) keyboard.row();
  });
  return keyboard;
}

/**
 * Send path for the ecosystemFeed's new categories (2026-07-31) — HTML
 * `parse_mode` + `sendPhoto` + an inline keyboard, per the feature's
 * explicit requirement. Deliberately a NEW function alongside
 * sendBrandedMessage above, not a modification of it — the existing 6
 * activityFeed categories keep using the untouched Markdown/no-buttons path,
 * zero regression risk.
 *
 * Accepts either a raw locally-generated Buffer (the new tokenStatCard
 * template, categories 1-4) or a SendableTradePhoto (the Biggest Winners
 * category reuses @nova/telegram-bot's resolveTradePhoto — the real
 * GeckoTerminal-chart photo already built for a closed position — rather
 * than duplicating chart-rendering code), same fileId/buffer branching as
 * tradeNotification.ts's own sendTradeNotificationPhoto.
 *
 * `photo` may be `undefined` (the Biggest Winners category's chart-photo
 * resolution can fail the same rare way tradeNotification.ts's own
 * resolveTradePhoto already documents) — falls back to sendMessage with the
 * same caption/buttons rather than dropping the post entirely.
 *
 * Caller is responsible for HTML-escaping any dynamic text in `captionHtml`
 * (see ecosystemFeed/format.ts's escapeHtml) — this function sends exactly
 * what it's given.
 */
export async function sendBrandedPhotoHtml(
  bot: Bot,
  chatId: string,
  photo: Buffer | SendableTradePhoto | undefined,
  captionHtml: string,
  buttonRows: ButtonSpec[][] = [],
): Promise<{ message_id: number; photo?: { file_id: string }[] }> {
  const reply_markup = buildInlineKeyboard(buttonRows);
  if (!photo) {
    return bot.api.sendMessage(chatId, captionHtml, { parse_mode: 'HTML', reply_markup });
  }
  const source = Buffer.isBuffer(photo)
    ? new InputFile(photo)
    : isFileId(photo)
      ? photo.fileId
      : new InputFile(photo.buffer);
  return bot.api.sendPhoto(chatId, source, {
    caption: captionHtml,
    parse_mode: 'HTML',
    reply_markup,
  });
}
