import { navOnly } from '../keyboards.js';
import { usd, fmtDate, shortKey } from '../format.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const MAX_SHOWN = 10;

export async function renderReferralEarnings(
  deps: ScreenDeps,
  user: ScreenUser,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).referralEarnings;
  const rewards = await deps.prisma.referralReward.findMany({
    where: { referrerUserId: user.id },
    orderBy: { createdAt: 'desc' },
    take: MAX_SHOWN,
    include: { referredUser: { select: { telegramId: true } } },
  });

  let text = d.header;

  if (rewards.length === 0) {
    text += d.empty;
  } else {
    text += rewards
      .map((r) => {
        const from = r.referredUser.telegramId ?? shortKey(r.referredUserId);
        return d.row(r.level, usd(r.rewardUsd), from, fmtDate(r.createdAt));
      })
      .join('\n\n');
  }

  return { text, keyboard: navOnly('fee_dashboard', lang) };
}
