import { InlineKeyboard } from 'grammy';
import { getOrCreateBusinessSettings } from '@nova/shared';
import { withNav } from '../keyboards.js';
import { getLocale, t } from '../../i18n/index.js';
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
  user: ScreenUser,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).feePolicyConsent;
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
          .map((l) => d.referralLevelRow(l.level, (l.percentBps / 100).toFixed(1)))
          .join('\n')
      : d.referralDisabled;

  const text =
    `${d.title}` +
    `${d.freeNote}` +
    `${d.feeSectionTitle}` +
    `${d.feeSectionBody}` +
    `${d.currentFee(feePercent)}` +
    `${d.yourShareTitle}` +
    `${d.yourShareBody(userSharePercent)}` +
    `${d.referralTitle}${referralLines}\n` +
    `${d.referralSourceNote(feePercent)}` +
    `${d.ctaNote}`;

  const keyboard = new InlineKeyboard().text(d.acceptButton, 'a:sniper:acceptpolicy');
  return { text, keyboard: withNav(keyboard, 'home', lang) };
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
