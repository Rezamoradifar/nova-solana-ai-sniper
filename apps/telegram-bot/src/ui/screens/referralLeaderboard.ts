import { navOnly } from '../keyboards.js';
import { usd, shortKey } from '../format.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const MAX_SHOWN = 10;

/** Global top referrers by total earned — distinct from the existing 🏆
 * Leaderboard screen (leaderboard.ts), which ranks trading PnL, not referrals. */
export async function renderReferralLeaderboard(
  deps: ScreenDeps,
  user: ScreenUser,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).referralLeaderboard;
  const grouped = await deps.prisma.referralReward.groupBy({
    by: ['referrerUserId'],
    _sum: { rewardUsd: true },
    orderBy: { _sum: { rewardUsd: 'desc' } },
    take: MAX_SHOWN,
  });

  let text = d.header;

  if (grouped.length === 0) {
    text += d.empty;
  } else {
    const referrers = await deps.prisma.user.findMany({
      where: { id: { in: grouped.map((g) => g.referrerUserId) } },
      select: { id: true, telegramId: true },
    });
    const labelById = new Map(referrers.map((u) => [u.id, u.telegramId ?? shortKey(u.id)]));
    text += grouped
      .map((g, i) => d.row(i + 1, labelById.get(g.referrerUserId) ?? '—', usd(g._sum.rewardUsd)))
      .join('\n');
  }

  return { text, keyboard: navOnly('fee_dashboard', lang) };
}
