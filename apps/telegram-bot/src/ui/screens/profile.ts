import { navOnly } from '../keyboards.js';
import { fmtDate, escapeMd } from '../format.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';
import type { Context } from 'grammy';

export async function renderProfile(
  deps: ScreenDeps,
  user: ScreenUser,
  ctx: Context,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).profile;
  const walletCount = await deps.prisma.wallet.count({ where: { userId: user.id } });
  // Telegram display names/usernames are fully user-controlled — a stray "_" or "*"
  // would otherwise break Markdown parsing for the whole message.
  const name = escapeMd(
    [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || '—',
  );
  const username = ctx.from?.username ? `@${escapeMd(ctx.from.username)}` : '—';

  const text =
    `${d.title}\n\n` +
    `${d.name(name)}\n` +
    `${d.username(username)}\n` +
    `${d.telegramId(String(ctx.from?.id ?? '—'))}\n` +
    `${d.memberSince(fmtDate(user.createdAt))}\n` +
    `${d.wallets(walletCount)}\n` +
    `${d.plan(user.subscriptionTier)}\n` +
    `${d.referralCode(user.referralCode ?? '—')}`;

  return { text, keyboard: navOnly('home', lang) };
}
