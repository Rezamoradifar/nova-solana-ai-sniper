import { InlineKeyboard } from 'grammy';
import { withNav } from '../keyboards.js';
import { addTokenButtons, formatTokenRow, MAX_SHOWN } from './tokenList.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

/** Telegram-sourced tokens only (t.me/trendingssol, t.me/trending) that
 * cleared every gate (dedupe, blacklist, liquidity, AI score) — see
 * worker.ts's handleTelegramSignal. Rejected candidates are never persisted,
 * so this list is inherently "qualified opportunities" only. */
export async function renderTrending(deps: ScreenDeps, _user: ScreenUser): Promise<ScreenResult> {
  const tokens = await deps.prisma.token.findMany({
    where: { discoverySource: 'TELEGRAM' },
    orderBy: { createdAt: 'desc' },
    take: MAX_SHOWN,
  });

  let text = '🚀 *Trending — Telegram Signals*\n\n';
  const keyboard = new InlineKeyboard();

  if (tokens.length === 0) {
    text +=
      'No Telegram-sourced tokens yet. Signals from t.me/trendingssol and t.me/trending that clear the liquidity and AI-score filters will show up here.';
  } else {
    text += tokens.map(formatTokenRow).join('\n\n');
    for (const t of tokens) addTokenButtons(keyboard, t);
  }

  return { text, keyboard: withNav(keyboard, 'home') };
}
