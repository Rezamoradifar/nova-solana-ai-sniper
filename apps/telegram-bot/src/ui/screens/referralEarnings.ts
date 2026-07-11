import { navOnly } from '../keyboards.js';
import { usd, fmtDate, shortKey } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const MAX_SHOWN = 10;

export async function renderReferralEarnings(
  deps: ScreenDeps,
  user: ScreenUser,
): Promise<ScreenResult> {
  const rewards = await deps.prisma.referralReward.findMany({
    where: { referrerUserId: user.id },
    orderBy: { createdAt: 'desc' },
    take: MAX_SHOWN,
    include: { referredUser: { select: { telegramId: true } } },
  });

  let text = '📜 *Referral Earnings History*\n\n';

  if (rewards.length === 0) {
    text +=
      'No referral earnings yet — share your referral link from 🔗 Referrals to start earning.';
  } else {
    text += rewards
      .map((r) => {
        const from = r.referredUser.telegramId ?? shortKey(r.referredUserId);
        return `🔗 Level ${r.level} — ${usd(r.rewardUsd)} from ${from}\n${fmtDate(r.createdAt)}`;
      })
      .join('\n\n');
  }

  return { text, keyboard: navOnly('fee_dashboard') };
}
