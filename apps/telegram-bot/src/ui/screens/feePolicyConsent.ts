import { InlineKeyboard } from 'grammy';
import { getOrCreateBusinessSettings } from '@nova/shared';
import { withNav } from '../keyboards.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

/**
 * Gate used by sniper.ts before enabling auto-trading. Re-checked (not just
 * cached from acceptance time) so a later admin fee change automatically
 * requires re-acceptance — feePolicyAcceptedFeeBps is a snapshot of what was
 * actually agreed to, not just "has this user ever accepted anything."
 */
export async function hasAcceptedCurrentFeePolicy(
  deps: ScreenDeps,
  user: ScreenUser,
): Promise<boolean> {
  if (!user.feePolicyAcceptedAt || user.feePolicyAcceptedFeeBps == null) return false;
  const settings = await getOrCreateBusinessSettings(deps.prisma);
  return user.feePolicyAcceptedFeeBps === settings.performanceFeeBps;
}

export async function renderFeePolicyConsent(
  deps: ScreenDeps,
  _user: ScreenUser,
): Promise<ScreenResult> {
  const settings = await getOrCreateBusinessSettings(deps.prisma);
  const feePercent = (settings.performanceFeeBps / 100).toFixed(1);
  const userSharePercent = (100 - settings.performanceFeeBps / 100).toFixed(1);
  const enabledLevels = settings.referralProgramEnabled
    ? settings.referralLevels.filter((l) => l.enabled)
    : [];

  // Section 14 (2026-07-18): referral rewards are now a fixed percentage of
  // net profit directly (registerFeeSystem.ts's calculateFixedProfitDistribution),
  // not a cut of the platform fee shown above — this wording used to say "of
  // the platform fee," which stopped being true once that computation changed.
  const referralLines =
    enabledLevels.length > 0
      ? enabledLevels
          .map(
            (l) => `  • Level ${l.level}: ${(l.percentBps / 100).toFixed(1)}% of your net profit`,
          )
          .join('\n')
      : '  • Referral program is currently disabled';

  const text =
    `📜 *Performance Fee & Referral Policy*\n\n` +
    `Registration is free — no monthly subscription, ever.\n\n` +
    `💸 *Performance Fee*\n` +
    `You only pay a fee on a *profitable, completed* trade — never on a losing or break-even trade, and never before a trade actually closes.\n` +
    `Current fee: *${feePercent}%* of realized net profit, after trading costs.\n\n` +
    `👤 *Your Profit Share*\n` +
    `You keep *${userSharePercent}%* of net profit on every profitable trade.\n\n` +
    `🔗 *Referral Program*\n${referralLines}\n` +
    `Referral rewards come out of the platform's own ${feePercent}% share — never an extra charge on your profit.\n\n` +
    `Tap below to accept and enable auto-trading. If this policy ever changes, you'll be asked to accept again before it applies to you.`;

  const keyboard = new InlineKeyboard().text(
    '✅ I Agree, Enable Auto-Trading',
    'a:sniper:acceptpolicy',
  );
  return { text, keyboard: withNav(keyboard, 'home') };
}

/** Returns the updated user row — the caller's in-memory `user` object is
 * stale the moment this resolves, so re-rendering a gated screen must use
 * this return value, not the original `user` parameter. */
export async function handleAcceptFeePolicy(
  deps: ScreenDeps,
  user: ScreenUser,
): Promise<ScreenUser> {
  const settings = await getOrCreateBusinessSettings(deps.prisma);
  return deps.prisma.user.update({
    where: { id: user.id },
    data: { feePolicyAcceptedAt: new Date(), feePolicyAcceptedFeeBps: settings.performanceFeeBps },
  });
}
