import { InlineKeyboard } from 'grammy';
import { withNav } from '../keyboards.js';
import { getLocale, resolveLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

export async function renderLanguage(_deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).language;
  const keyboard = new InlineKeyboard()
    .text(d.english, 'a:lang:set:en')
    .text(d.persian, 'a:lang:set:fa');
  return { text: `${d.title}\n\n${d.prompt}`, keyboard: withNav(keyboard, 'settings', lang) };
}

/** Persists the chosen language on the User row and returns it, resolved to a
 * known Locale (an unrecognized value from callback_data falls back to "en"
 * rather than writing garbage). */
export async function applyLanguage(
  deps: ScreenDeps,
  user: ScreenUser,
  rawLang: string,
): Promise<ScreenUser> {
  const language = resolveLocale(rawLang);
  return deps.prisma.user.update({ where: { id: user.id }, data: { language } });
}
