import { navOnly } from '../keyboards.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

export async function renderHelp(_deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  return { text: t(lang).help.text, keyboard: navOnly('home', lang) };
}
