import { createHash } from 'node:crypto';

/** Normalizes whitespace/case before hashing so trivial rewordings still
 * count as duplicates. Hashes the full bilingual content together (both
 * languages) since that's what's actually published as one message — see
 * MarketingPost's own schema doc comment. */
export function hashContent(
  titleEn: string,
  bodyEn: string,
  titleFa: string,
  bodyFa: string,
): string {
  const normalized = `${titleEn}\n${bodyEn}\n${titleFa}\n${bodyFa}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}
