import { navOnly } from '../keyboards.js';
import { sol, fmtDate, escapeMd } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const MAX_SHOWN = 10;

export async function renderTrades(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const trades = await deps.prisma.trade.findMany({
    where: { wallet: { userId: user.id } },
    include: { token: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_SHOWN,
  });

  let text = '💱 *Trades*\n\n';

  if (trades.length === 0) {
    text += 'No trades yet.';
  } else {
    text += trades
      .map((t) => {
        const emoji = t.side === 'BUY' ? '🟢' : '🔴';
        const symbol = escapeMd(t.token.symbol ?? t.token.mint.slice(0, 6));
        const statusBadge = t.status === 'CONFIRMED' ? '' : ` (${t.status.toLowerCase()})`;
        return `${emoji} *${t.side}* ${symbol} — ${sol(t.amountSol)}${statusBadge}\n${fmtDate(t.createdAt)}`;
      })
      .join('\n\n');
  }

  return { text, keyboard: navOnly('home') };
}
