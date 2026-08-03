import { InlineKeyboard } from 'grammy';
import { withNav } from '../keyboards.js';
import { addTokenButtons, formatTokenRow, MAX_SHOWN } from './tokenList.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

/** Every recently-qualified token regardless of discovery source (on-chain
 * scanners + the Telegram trend source) — the general "what's worth looking
 * at right now" feed. Same query shape as GET /tokens in apps/api. */
export async function renderLiveOpportunities(
  deps: ScreenDeps,
  user: ScreenUser,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).liveOpportunities;
  const tokens = await deps.prisma.token.findMany({
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
