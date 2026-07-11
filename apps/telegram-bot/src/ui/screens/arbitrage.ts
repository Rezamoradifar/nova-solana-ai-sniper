import { navOnly } from '../keyboards.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

/** Placeholder — there is no arbitrage backend anywhere in this codebase
 * today. Shown as "coming soon" rather than wired to anything fake. */
export async function renderArbitrage(_deps: ScreenDeps, _user: ScreenUser): Promise<ScreenResult> {
  return {
    text: '🚧 *Arbitrage*\n\nThis feature is not yet available.\nCheck back soon!',
    keyboard: navOnly('home'),
  };
}
