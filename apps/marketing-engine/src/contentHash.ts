import { createHash } from 'node:crypto';

/** Normalizes whitespace/case before hashing so trivial rewordings still count as duplicates. */
export function hashContent(title: string, body: string): string {
  const normalized = `${title}\n${body}`.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}
