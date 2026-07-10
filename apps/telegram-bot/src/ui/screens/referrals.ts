import { InlineKeyboard } from 'grammy';
import { withNav } from '../keyboards.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';
import type { Context } from 'grammy';

export async function renderReferrals(
  deps: ScreenDeps,
  user: ScreenUser,
  ctx: Context,
): Promise<ScreenResult> {
  const referredCount = user.referralCode
    ? await deps.prisma.user.count({ where: { referredByCode: user.referralCode } })
    : 0;

  const botUsername = ctx.me?.username;
  const link =
    botUsername && user.referralCode
      ? `https://t.me/${botUsername}?start=${user.referralCode}`
      : undefined;

  const text =
    `🔗 *Referrals*\n\n` +
    `Your code: \`${user.referralCode ?? '—'}\`\n` +
    `People referred: *${referredCount}*\n\n` +
    (link
      ? // Backtick-wrapped: a bot username containing "_" would otherwise read as an
        // unpaired italic marker and make Telegram's legacy Markdown parser reject the
        // whole message (confirmed live — this broke the screen for a real user).
        `Share your link — anyone who opens the bot through it is automatically credited to you:\n\`${link}\``
      : 'Share your code with friends so they get credited to you when they join.');

  const keyboard = new InlineKeyboard().text('🔄 Refresh', 'a:referrals:refresh');

  return { text, keyboard: withNav(keyboard, 'home') };
}
