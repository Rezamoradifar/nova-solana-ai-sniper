import { PortfolioService } from '@nova/shared';
import { navOnly } from '../keyboards.js';
import { usd, pnlEmoji, shortKey, escapeMd } from '../format.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

export async function renderLeaderboard(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).leaderboard;
  const portfolioService = new PortfolioService(deps.prisma);
  const rows = await portfolioService.getLeaderboard(10);

  let text = d.header;

  if (rows.length === 0) {
    text += d.empty;
  } else {
    text += rows
      .map((r, i) =>
        d.row(
          i + 1,
          pnlEmoji(r.realizedPnlUsd),
          escapeMd(r.label ?? shortKey(r.publicKey)),
          usd(r.realizedPnlUsd),
          r.closedTrades,
        ),
      )
      .join('\n');
  }

  return { text, keyboard: navOnly('home', lang) };
}
