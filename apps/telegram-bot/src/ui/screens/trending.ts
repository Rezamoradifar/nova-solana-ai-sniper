import { InlineKeyboard } from 'grammy';
import { withNav } from '../keyboards.js';
import { addTokenButtons, formatTokenRow, MAX_SHOWN } from './tokenList.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

/** Telegram-sourced tokens only (t.me/trendingssol, t.me/trending) that
 * cleared every gate (dedupe, blacklist, liquidity, AI score) — see
 * worker.ts's handleTelegramSignal. Rejected candidates are never persisted,
 * so this list is inherently "qualified opportunities" only. */
export async function renderTrending(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).trending;
  const tokens = await deps.prisma.token.findMany({
    where: { discoverySource: 'TELEGRAM' },
    orderBy: { createdAt: 'desc' },
    take: MAX_SHOWN,
  });

  let text = d.header;
  const keyboard = new InlineKeyboard();

  if (tokens.length === 0) {
    text += d.empty;
  } else {
    text += tokens.map((tok) => formatTokenRow(tok, lang)).join('\n\n');
    for (const tok of tokens) addTokenButtons(keyboard, tok, lang);
  }

  return { text, keyboard: withNav(keyboard, 'home', lang) };
}
