export type Locale = 'en' | 'fa';

export const DEFAULT_LOCALE: Locale = 'en';

/** Anything that isn't exactly "fa" resolves to English — same fail-safe
 * default as every other optional/nullable field read off a User row. */
export function resolveLocale(value: string | null | undefined): Locale {
  return value === 'fa' ? 'fa' : 'en';
}

export function getLocale(user: { language?: string | null }): Locale {
  return resolveLocale(user.language);
}
