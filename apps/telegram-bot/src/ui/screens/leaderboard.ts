import { PortfolioService } from '@nova/shared';
import { navOnly } from '../keyboards.js';
import { usd, pnlEmoji, shortKey, escapeMd } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

export async function renderLeaderboard(
  deps: ScreenDeps,
  _user: ScreenUser,
): Promise<ScreenResult> {
  const portfolioService = new PortfolioService(deps.prisma);
  const rows = await portfolioService.getLeaderboard(10);

  let text = '🏆 *Leaderboard*\n\nTop wallets by realized PnL:\n\n';

  if (rows.length === 0) {
    text += 'No closed trades yet — be the first!';
  } else {
    text += rows
      .map(
        (r, i) =>
          `${i + 1}. ${pnlEmoji(r.realizedPnlUsd)} ${escapeMd(r.label ?? shortKey(r.publicKey))} — ${usd(r.realizedPnlUsd)} (${r.closedTrades} closed)`,
      )
      .join('\n');
  }

  return { text, keyboard: navOnly('home') };
}
