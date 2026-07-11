import { InlineKeyboard } from 'grammy';
import { withNav } from '../keyboards.js';
import { addTokenButtons, formatTokenRow, MAX_SHOWN } from './tokenList.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

/** Every recently-qualified token regardless of discovery source (on-chain
 * scanners + the Telegram trend source) — the general "what's worth looking
 * at right now" feed. Same query shape as GET /tokens in apps/api. */
export async function renderLiveOpportunities(
  deps: ScreenDeps,
  _user: ScreenUser,
): Promise<ScreenResult> {
  const tokens = await deps.prisma.token.findMany({
    orderBy: { createdAt: 'desc' },
    take: MAX_SHOWN,
  });

  let text = '🔥 *Live Opportunities*\n\n';
  const keyboard = new InlineKeyboard();

  if (tokens.length === 0) {
    text += 'No tokens detected yet.';
  } else {
    text += tokens.map(formatTokenRow).join('\n\n');
    for (const t of tokens) addTokenButtons(keyboard, t);
  }

  return { text, keyboard: withNav(keyboard, 'home') };
}
