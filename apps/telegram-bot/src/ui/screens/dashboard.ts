import { PortfolioService } from '@nova/shared';
import { navOnly } from '../keyboards.js';
import { sol, usd, pnlEmoji } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

export async function renderDashboard(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const portfolioService = new PortfolioService(deps.prisma);

  const [wallets, tokenCount, tradeCount] = await Promise.all([
    deps.prisma.wallet.findMany({ where: { userId: user.id } }),
    deps.prisma.token.count(),
    deps.prisma.trade.count({ where: { wallet: { userId: user.id } } }),
  ]);

  const summaries = await Promise.all(
    wallets.map((w) => portfolioService.getSummary(w.id, new Map())),
  );

  const totals = summaries.reduce(
    (acc, s) => ({
      openPositions: acc.openPositions + s.openPositions,
      investedSol: acc.investedSol + s.totalInvestedSol,
      realizedPnlUsd: acc.realizedPnlUsd + s.realizedPnlUsd,
      unrealizedPnlUsd: acc.unrealizedPnlUsd + s.unrealizedPnlUsd,
    }),
    { openPositions: 0, investedSol: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0 },
  );

  const text =
    `📊 *Dashboard*\n\n` +
    `📈 Open positions: *${totals.openPositions}*\n` +
    `💵 Invested: *${sol(totals.investedSol)}*\n` +
    `${pnlEmoji(totals.realizedPnlUsd)} Realized PnL: *${usd(totals.realizedPnlUsd)}*\n` +
    `${pnlEmoji(totals.unrealizedPnlUsd)} Unrealized PnL: *${usd(totals.unrealizedPnlUsd)}*\n\n` +
    `💱 Your trades: *${tradeCount}*\n` +
    `🪙 Tokens tracked platform-wide: *${tokenCount}*`;

  return { text, keyboard: navOnly('home') };
}
