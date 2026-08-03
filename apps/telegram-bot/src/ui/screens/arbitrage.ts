import { navOnly } from '../keyboards.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

/** Placeholder — there is no arbitrage backend anywhere in this codebase
 * today. Shown as "coming soon" rather than wired to anything fake. */
export async function renderArbitrage(_deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  return {
    text: t(lang).arbitrage.text,
    keyboard: navOnly('home', lang),
  };
}
