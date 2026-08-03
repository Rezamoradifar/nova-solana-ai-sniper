import { PortfolioService } from '@nova/shared';
import { navOnly } from '../keyboards.js';
import { sol, usd, pnlEmoji, shortKey, escapeMd } from '../format.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

export async function renderPortfolio(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).portfolio;
  const portfolioService = new PortfolioService(deps.prisma);
  const wallets = await deps.prisma.wallet.findMany({ where: { userId: user.id } });

  let text = `${d.title}\n\n`;

  if (wallets.length === 0) {
    text += d.empty;
  } else {
    const summaries = await Promise.all(
      wallets.map(async (w) => ({
        wallet: w,
        summary: await portfolioService.getSummary(w.id, new Map()),
      })),
    );
    text += summaries
      .map(({ wallet, summary }) =>
        d.row(
          escapeMd(wallet.label),
          shortKey(wallet.publicKey),
          summary.openPositions,
          sol(summary.totalInvestedSol),
          pnlEmoji(summary.realizedPnlUsd),
          usd(summary.realizedPnlUsd),
          pnlEmoji(summary.unrealizedPnlUsd),
          usd(summary.unrealizedPnlUsd),
        ),
      )
      .join('\n\n');
  }

  return { text, keyboard: navOnly('home', lang) };
}
