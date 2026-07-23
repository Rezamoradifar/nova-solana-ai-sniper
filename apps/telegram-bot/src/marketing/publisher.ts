import type { Bot } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import type { Logger } from '@nova/shared';
import { escapeMd } from '../ui/format.js';

export interface PublishablePost {
  id: string;
  titleEn: string;
  bodyEn: string;
  titleFa: string;
  bodyFa: string;
  /** Local filesystem path to a generated visual (see
   * apps/marketing-engine/src/visuals/) — never a remote URL; sent via
   * grammy's InputFile, which reads and uploads the file directly. */
  imagePath?: string | null;
  buttons?: unknown;
  /** Hashtags to append as their own line at the very end of the post (see
   * apps/marketing-engine/src/hashtags.ts) — already `#`-prefixed, plain
   * text, never AI freeform output, so never Markdown-escaped like the
   * title/body fields are. */
  hashtags?: string[];
}

interface ButtonSpec {
  text: string;
  url: string;
}

function buildKeyboard(buttons: unknown): InlineKeyboard | undefined {
  if (!Array.isArray(buttons) || buttons.length === 0) return undefined;
  const keyboard = new InlineKeyboard();
  for (const button of buttons as ButtonSpec[]) {
    if (button?.text && button?.url) {
      keyboard.url(button.text, button.url).row();
    }
  }
  return keyboard;
}

const SECTION_DIVIDER = '—————'; // em dashes — plain text, never a Markdown control char

/** Telegram's own hard limits — a text message tops out at 4096 characters,
 * but a *photo caption* is capped much lower, at 1024. Sending a caption
 * over that limit fails the whole call, so it's truncated defensively
 * rather than trusting every generated post to stay under it (verified
 * against Telegram's Bot API documentation). */
const PHOTO_CAPTION_MAX = 1024;
/** A plain text message's own, much higher limit — used for the no-image
 * path. Applying the same reserve-space-for-hashtags composition here too
 * (even though a generated post is normally far under this) means the
 * hashtag line can never be the thing that pushes a send over budget. */
const TEXT_MESSAGE_MAX = 4096;

function truncateForCaption(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

interface ComposedText {
  text: string;
  truncated: boolean;
}

/** Appends the hashtag line to `body`, truncating `body` (never the
 * hashtags) if the combination would exceed `max` — the hashtags are the
 * whole point of this feature, so they're never what gets cut. */
function composeWithHashtags(
  body: string,
  hashtags: string[] | undefined,
  max: number,
): ComposedText {
  if (!hashtags || hashtags.length === 0) {
    const text = truncateForCaption(body, max);
    return { text, truncated: text.length < body.length };
  }

  const hashtagLine = hashtags.join(' ');
  const suffix = `\n\n${hashtagLine}`;
  if (body.length + suffix.length <= max) {
    return { text: body + suffix, truncated: false };
  }

  const bodyBudget = Math.max(0, max - suffix.length);
  const truncatedBody = truncateForCaption(body, bodyBudget);
  return { text: truncatedBody + suffix, truncated: true };
}

export interface PublishResult {
  messageId: number;
}

/** Publishes a MarketingPost record to the configured broadcast chat as
 * Markdown — one message with both an English and a Persian section (see
 * PublishablePost's own doc comment), and the generated visual (if any) as
 * that same message's photo, never a separate send. Returns the sent
 * message's id so a caller (e.g. a one-off test-post script) can confirm
 * the exact Telegram message that went out. */
export async function publishPost(
  bot: Bot,
  chatId: string,
  post: PublishablePost,
  logger: Logger,
): Promise<PublishResult> {
  // Every field is AI-generated marketing copy, not literal Markdown source —
  // a stray "_"/"*"/"`" (e.g. "50%_off") would otherwise break Telegram's
  // legacy Markdown parser and fail the whole scheduled post. Each field is
  // escaped independently, then the two "*bold*" wraps are applied by this
  // code — never by the AI output — same convention as the pre-bilingual
  // version of this function.
  const bodyText = [
    `*${escapeMd(post.titleEn)}*`,
    escapeMd(post.bodyEn),
    '',
    SECTION_DIVIDER,
    '',
    `*${escapeMd(post.titleFa)}*`,
    escapeMd(post.bodyFa),
  ].join('\n');
  const keyboard = buildKeyboard(post.buttons);

  try {
    if (post.imagePath) {
      const { text: caption, truncated } = composeWithHashtags(
        bodyText,
        post.hashtags,
        PHOTO_CAPTION_MAX,
      );
      if (truncated) {
        logger.warn(
          { postId: post.id, fullLength: bodyText.length },
          'marketing post caption exceeded the Telegram photo-caption limit (1024) — truncated rather than sent as a second message',
        );
      }
      const sent = await bot.api.sendPhoto(chatId, new InputFile(post.imagePath), {
        caption,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      return { messageId: sent.message_id };
    }

    const { text, truncated } = composeWithHashtags(bodyText, post.hashtags, TEXT_MESSAGE_MAX);
    if (truncated) {
      logger.warn(
        { postId: post.id, fullLength: bodyText.length },
        'marketing post text exceeded the Telegram message limit (4096) — truncated',
      );
    }
    const sent = await bot.api.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    return { messageId: sent.message_id };
  } catch (err) {
    logger.error({ err, postId: post.id }, 'failed to publish marketing post');
    throw err;
  }
}
