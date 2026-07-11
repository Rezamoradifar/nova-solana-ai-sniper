import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Logger } from '@nova/shared';
import { escapeMd } from '../ui/format.js';

export interface PublishablePost {
  id: string;
  title: string;
  body: string;
  imageUrl?: string | null;
  buttons?: unknown;
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

/** Publishes a MarketingPost record to the configured broadcast chat as Markdown. */
export async function publishPost(
  bot: Bot,
  chatId: string,
  post: PublishablePost,
  logger: Logger,
): Promise<void> {
  // title/body are AI-generated marketing copy, not literal Markdown source — a
  // stray "_"/"*"/"`" (e.g. "50%_off") would otherwise break Telegram's legacy
  // Markdown parser and fail the whole scheduled post.
  const caption = `*${escapeMd(post.title)}*\n\n${escapeMd(post.body)}`;
  const keyboard = buildKeyboard(post.buttons);

  try {
    if (post.imageUrl) {
      await bot.api.sendPhoto(chatId, post.imageUrl, {
        caption,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } else {
      await bot.api.sendMessage(chatId, caption, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    logger.error({ err, postId: post.id }, 'failed to publish marketing post');
    throw err;
  }
}
