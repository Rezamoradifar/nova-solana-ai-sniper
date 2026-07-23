import { describe, expect, it } from 'vitest';
import { resolveLocale, getLocale } from './locale.js';
import { normalizeDigits } from './digits.js';
import { t } from './index.js';

describe('resolveLocale / getLocale', () => {
  it('resolves "fa" to Persian', () => {
    expect(resolveLocale('fa')).toBe('fa');
    expect(getLocale({ language: 'fa' })).toBe('fa');
  });

  it('defaults anything else (unset, null, unknown) to English', () => {
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale('xx')).toBe('en');
    expect(getLocale({})).toBe('en');
  });
});

describe('normalizeDigits', () => {
  it('converts Persian digits to ASCII', () => {
    expect(normalizeDigits('۱۵')).toBe('15');
  });

  it('converts Arabic-Indic digits to ASCII', () => {
    expect(normalizeDigits('٣٠٠')).toBe('300');
  });

  it('leaves ASCII digits and other characters untouched', () => {
    expect(normalizeDigits('0.25')).toBe('0.25');
  });
});

describe('t(lang)', () => {
  it('returns distinct English and Persian dictionaries for the same key', () => {
    expect(t('en').common.back).toBe('⬅️ Back');
    expect(t('fa').common.back).toBe('⬅️ بازگشت');
  });
});
