import { InlineKeyboard } from 'grammy';
import { withNav } from '../keyboards.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';
import type { Context } from 'grammy';

export async function renderReferrals(
  deps: ScreenDeps,
  user: ScreenUser,
  ctx: Context,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).referrals;
  const referredCount = user.referralCode
    ? await deps.prisma.user.count({ where: { referredByCode: user.referralCode } })
    : 0;

  const botUsername = ctx.me?.username;
  const link =
    botUsername && user.referralCode
      ? `https://t.me/${botUsername}?start=${user.referralCode}`
      : undefined;

  const text =
    `${d.title}\n\n` +
    `${d.yourCode(user.referralCode ?? '—')}\n` +
    `${d.peopleReferred(referredCount)}\n\n` +
    // Backtick-wrapped: a bot username containing "_" would otherwise read as an
    // unpaired italic marker and make Telegram's legacy Markdown parser reject the
    // whole message (confirmed live — this broke the screen for a real user).
    (link ? d.shareLink(link) : d.shareCodeOnly);

  const keyboard = new InlineKeyboard().text(d.refresh, 'a:referrals:refresh');

  return { text, keyboard: withNav(keyboard, 'home', lang) };
}
