const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/**
 * Normalizes Persian and Arabic-Indic digits to ASCII before any `Number(raw)`
 * parse of free-text input (settings edits, TP/SL edits) — a Persian-locale
 * user typing on a Persian keyboard produces "۱۵" for "15", which `Number()`
 * can't parse on its own.
 */
export function normalizeDigits(raw: string): string {
  return raw.replace(/[۰-۹٠-٩]/g, (ch) => {
    const persianIndex = PERSIAN_DIGITS.indexOf(ch);
    if (persianIndex !== -1) return String(persianIndex);
    const arabicIndex = ARABIC_INDIC_DIGITS.indexOf(ch);
    return arabicIndex !== -1 ? String(arabicIndex) : ch;
  });
}
