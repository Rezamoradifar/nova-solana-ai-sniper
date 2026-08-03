import { navOnly } from '../keyboards.js';
import { sol, fmtDate, escapeMd } from '../format.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const MAX_SHOWN = 10;

export async function renderTrades(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).trades;
  const trades = await deps.prisma.trade.findMany({
    where: { wallet: { userId: user.id } },
    include: { token: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_SHOWN,
  });

  let text = d.title;

  if (trades.length === 0) {
    text += d.empty;
  } else {
    text += trades
      .map((tr) => {
        const emoji = tr.side === 'BUY' ? '🟢' : '🔴';
        const symbol = escapeMd(tr.token.symbol ?? tr.token.mint.slice(0, 6));
        const statusKey = tr.status.toLowerCase();
        const statusBadge =
          tr.status === 'CONFIRMED' ? '' : ` (${d.statusLabels[statusKey] ?? statusKey})`;
        return d.row(emoji, tr.side, symbol, sol(tr.amountSol), statusBadge, fmtDate(tr.createdAt));
      })
      .join('\n\n');
  }

  return { text, keyboard: navOnly('home', lang) };
}
