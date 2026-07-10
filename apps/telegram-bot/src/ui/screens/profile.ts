import { navOnly } from '../keyboards.js';
import { fmtDate, escapeMd } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';
import type { Context } from 'grammy';

export async function renderProfile(
  deps: ScreenDeps,
  user: ScreenUser,
  ctx: Context,
): Promise<ScreenResult> {
  const walletCount = await deps.prisma.wallet.count({ where: { userId: user.id } });
  // Telegram display names/usernames are fully user-controlled — a stray "_" or "*"
  // would otherwise break Markdown parsing for the whole message.
  const name = escapeMd(
    [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || '—',
  );
  const username = ctx.from?.username ? `@${escapeMd(ctx.from.username)}` : '—';

  const text =
    `👤 *Profile*\n\n` +
    `Name: ${name}\n` +
    `Username: ${username}\n` +
    `Telegram ID: \`${ctx.from?.id ?? '—'}\`\n` +
    `Member since: ${fmtDate(user.createdAt)}\n` +
    `Wallets: *${walletCount}*\n` +
    `Plan: *${user.subscriptionTier}* — every feature is free and unlocked\n` +
    `Referral code: \`${user.referralCode ?? '—'}\``;

  return { text, keyboard: navOnly('home') };
}
