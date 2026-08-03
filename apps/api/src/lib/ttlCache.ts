/**
 * Minimal TTL "seen recently" cache — same shape as the inline `Map<string,
 * {expiresAt}>` pattern already used by RiskAnalyzer's result cache, pulled
 * out here because this feature needs it twice (Telegram mint dedupe cooldown,
 * AI-reject cooldown) with two different TTLs. Lazily swept on insert past a
 * size threshold rather than on a timer, matching that same precedent.
 */
export class TtlCache<K> {
  private readonly entries = new Map<K, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly sweepThreshold = 2000,
  ) {}

  has(key: K): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key: K): void {
    if (this.entries.size >= this.sweepThreshold) {
      const now = Date.now();
      for (const [k, expiresAt] of this.entries) {
        if (expiresAt <= now) this.entries.delete(k);
      }
    }
    this.entries.set(key, Date.now() + this.ttlMs);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Test-only: clears all entries so tests never leak state into each other
   * — same convention as resilientConnection.ts's counter/cooldown registries. */
  clear(): void {
    this.entries.clear();
  }
}
