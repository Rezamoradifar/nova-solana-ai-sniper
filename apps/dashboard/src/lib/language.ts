export type Language = 'en' | 'fa';
export const LANGUAGE_KEY = 'moneyland-language';

export function languageFrom(value: unknown): Language | null {
  return value === 'fa' || value === 'en' ? value : null;
}

export function initialLanguage(storage?: Pick<Storage, 'getItem'>, search = ''): Language {
  const requested = languageFrom(new URLSearchParams(search).get('lang'));
  if (requested) return requested;
  try {
    return languageFrom(storage?.getItem(LANGUAGE_KEY)) ?? 'en';
  } catch {
    return 'en';
  }
}
