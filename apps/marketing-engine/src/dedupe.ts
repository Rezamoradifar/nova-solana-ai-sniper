/** Complements contentHash.ts's exact-match dedupe: catches a reworded
 * near-repeat (same idea, different words) that would hash differently but
 * still read as repetitive to a channel subscriber. Word-shingle Jaccard
 * similarity — cheap, deterministic, no embedding/API call needed. */

const SHINGLE_SIZE = 5;
/** Above this similarity, two posts read as "basically the same content" to
 * a human skimming a channel. At 5-word shingles, a single changed word in a
 * ~15-word sentence (a trivial rewording) already scores ~0.4 — genuinely
 * different posts about the same category score far lower (near 0), since
 * they share almost no 5-word runs at all. */
export const NEAR_DUPLICATE_THRESHOLD = 0.4;

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(words: string[], size: number): Set<string> {
  if (words.length < size) return new Set(words.length > 0 ? [words.join(' ')] : []);
  const result = new Set<string>();
  for (let i = 0; i <= words.length - size; i++) {
    result.add(words.slice(i, i + size).join(' '));
  }
  return result;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const shingle of a) {
    if (b.has(shingle)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** True if `text` is near-duplicate (>= NEAR_DUPLICATE_THRESHOLD word-shingle
 * Jaccard similarity) of any of `recentTexts`. */
export function isNearDuplicate(text: string, recentTexts: string[]): boolean {
  const candidate = shingles(normalize(text), SHINGLE_SIZE);
  if (candidate.size === 0) return false;
  return recentTexts.some((recent) => {
    const other = shingles(normalize(recent), SHINGLE_SIZE);
    return jaccardSimilarity(candidate, other) >= NEAR_DUPLICATE_THRESHOLD;
  });
}
