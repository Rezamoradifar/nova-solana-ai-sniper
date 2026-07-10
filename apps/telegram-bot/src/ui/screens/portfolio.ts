import { PortfolioService } from '@nova/shared';
import { navOnly } from '../keyboards.js';
import { sol, usd, pnlEmoji, shortKey, escapeMd } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

export async function renderPortfolio(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const portfolioService = new PortfolioService(deps.prisma);
  const wallets = await deps.prisma.wallet.findMany({ where: { userId: user.id } });

  let text = '💰 *Portfolio*\n\n';

  if (wallets.length === 0) {
    text += 'You have no wallets yet — create one from 👛 Wallet.';
  } else {
    const summaries = await Promise.all(
      wallets.map(async (w) => ({
        wallet: w,
        summary: await portfolioService.getSummary(w.id, new Map()),
      })),
    );
    text += summaries
      .map(
        ({ wallet, summary }) =>
          `👛 ${escapeMd(wallet.label)} \`${shortKey(wallet.publicKey)}\`\n` +
          `Open: ${summary.openPositions} · Invested: ${sol(summary.totalInvestedSol)}\n` +
          `${pnlEmoji(summary.realizedPnlUsd)} Realized: ${usd(summary.realizedPnlUsd)} · ` +
          `${pnlEmoji(summary.unrealizedPnlUsd)} Unrealized: ${usd(summary.unrealizedPnlUsd)}`,
      )
      .join('\n\n');
  }

  return { text, keyboard: navOnly('home') };
}
