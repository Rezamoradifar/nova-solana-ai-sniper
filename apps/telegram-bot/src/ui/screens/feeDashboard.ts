import { InlineKeyboard } from 'grammy';
import { usd, pnlEmoji, shortKey } from '../format.js';
import { withNav } from '../keyboards.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * "Today's Profit"/"Lifetime Profit" are computed from Position.realizedPnlUsd
 * (every closed position, win or loss) — not from PerformanceFeeLedger, which
 * by design only has a row for profitable trades and would understate real
 * P&L if used here. Fees/referral earnings, correctly, ARE ledger-scoped.
 */
export async function renderFeeDashboard(
  deps: ScreenDeps,
  user: ScreenUser,
): Promise<ScreenResult> {
  const todayStart = startOfTodayUtc();
  const wallets = await deps.prisma.wallet.findMany({
    where: { userId: user.id },
    select: { id: true },
  });
  const walletIds = wallets.map((w) => w.id);

  const [todayAgg, lifetimeAgg, feesAgg, referralEarningsAgg, directReferredCount, topReferrals] =
    await Promise.all([
      deps.prisma.position.aggregate({
        where: { walletId: { in: walletIds }, status: 'CLOSED', closedAt: { gte: todayStart } },
        _sum: { realizedPnlUsd: true },
      }),
      deps.prisma.position.aggregate({
        where: { walletId: { in: walletIds }, status: 'CLOSED' },
        _sum: { realizedPnlUsd: true },
      }),
      deps.prisma.performanceFeeLedger.aggregate({
        where: { userId: user.id },
        _sum: { feeUsd: true },
      }),
      deps.prisma.referralReward.aggregate({
        where: { referrerUserId: user.id },
        _sum: { rewardUsd: true },
      }),
      user.referralCode
        ? deps.prisma.user.count({ where: { referredByCode: user.referralCode } })
        : Promise.resolve(0),
      deps.prisma.referralReward.groupBy({
        by: ['referredUserId'],
        where: { referrerUserId: user.id },
        _sum: { rewardUsd: true },
        orderBy: { _sum: { rewardUsd: 'desc' } },
        take: 3,
      }),
    ]);

  const todayProfit = todayAgg._sum.realizedPnlUsd ?? 0;
  const lifetimeProfit = lifetimeAgg._sum.realizedPnlUsd ?? 0;
  const feesPaid = feesAgg._sum.feeUsd ?? 0;
  const referralEarnings = referralEarningsAgg._sum.rewardUsd ?? 0;

  let topReferralsLine = '';
  if (topReferrals.length > 0) {
    const referredUsers = await deps.prisma.user.findMany({
      where: { id: { in: topReferrals.map((r) => r.referredUserId) } },
      select: { id: true, telegramId: true },
    });
    const labelById = new Map(referredUsers.map((u) => [u.id, u.telegramId ?? shortKey(u.id)]));
    topReferralsLine =
      '\n\n🏅 *Top Referrals*\n' +
      topReferrals
        .map(
          (r, i) =>
            `${i + 1}. ${labelById.get(r.referredUserId) ?? '—'} — ${usd(r._sum.rewardUsd)}`,
        )
        .join('\n');
  }

  const text =
    `💸 *Fees & Earnings*\n\n` +
    `${pnlEmoji(todayProfit)} Today's Profit: *${usd(todayProfit)}*\n` +
    `${pnlEmoji(lifetimeProfit)} Lifetime Profit: *${usd(lifetimeProfit)}*\n` +
    `📉 Performance Fees Paid: *${usd(feesPaid)}*\n` +
    `🔗 Referral Earnings: *${usd(referralEarnings)}*\n\n` +
    `👥 Direct Referrals: *${directReferredCount}*${topReferralsLine}`;

  const keyboard = new InlineKeyboard()
    .text('📜 Referral Earnings History', 's:referral_earnings')
    .row()
    .text('🏆 Referral Leaderboard', 's:referral_leaderboard');

  return { text, keyboard: withNav(keyboard, 'home') };
}
