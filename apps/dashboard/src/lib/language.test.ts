import { describe, expect, it } from 'vitest';
import { initialLanguage, LANGUAGE_KEY } from './language.js';
import { safeReturnPath } from './returnPath.js';

describe('shared website language and login continuity', () => {
  it('honors a mobile deep-link language before the saved language', () => {
    expect(initialLanguage({ getItem: () => 'en' }, '?lang=fa')).toBe('fa');
  });
  it('falls back to a valid saved choice or English when storage is blocked', () => {
    expect(initialLanguage({ getItem: (key) => (key === LANGUAGE_KEY ? 'fa' : null) })).toBe('fa');
    expect(
      initialLanguage({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('en');
    expect(initialLanguage({ getItem: () => 'fr' }, '?lang=invalid')).toBe('en');
  });
  it('returns users to the selected local tool including its query and fragment', () => {
    expect(safeReturnPath('/copy-trading?lang=fa#settings')).toBe('/copy-trading?lang=fa#settings');
  });
  it('does not allow external, recursive login, Mini App or API redirects', () => {
    for (const value of [
      'https://other.example',
      '//other.example',
      '/\\other.example',
      '/login',
      '/api/admin',
      '/app/',
      undefined,
    ]) {
      expect(safeReturnPath(value)).toBe('/dashboard');
    }
  });
});
