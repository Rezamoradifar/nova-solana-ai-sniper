import { en } from './en.js';
import { fa } from './fa.js';
import type { Locale } from './locale.js';

export type { Dict } from './en.js';
export * from './locale.js';
export * from './digits.js';

export function t(lang: Locale) {
  return lang === 'fa' ? fa : en;
}
