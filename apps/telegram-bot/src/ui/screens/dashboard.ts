import { PortfolioService } from '@nova/shared';
import { navOnly } from '../keyboards.js';
import { sol, usd, pnlEmoji } from '../format.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

export async function renderDashboard(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).dashboard;
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
    `${d.title}\n\n` +
    `${d.openPositions(totals.openPositions)}\n` +
    `${d.invested(sol(totals.investedSol))}\n` +
    `${d.realizedPnl(pnlEmoji(totals.realizedPnlUsd), usd(totals.realizedPnlUsd))}\n` +
    `${d.unrealizedPnl(pnlEmoji(totals.unrealizedPnlUsd), usd(totals.unrealizedPnlUsd))}\n\n` +
    `${d.yourTrades(tradeCount)}\n` +
    `${d.tokensTracked(tokenCount)}`;

  return { text, keyboard: navOnly('home', lang) };
}
