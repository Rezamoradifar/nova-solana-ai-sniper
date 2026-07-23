export interface DexScreenerTxnCounts {
  buys: number;
  sells: number;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  priceChange?: { h24?: number; h1?: number };
  /** Buy/sell transaction counts per window — a brand-new token typically only
   * has a real signal in the shortest window (m5); h1/h24 are sparse/zero in
   * its first minutes. See entryFilter.ts's buy/sell-ratio check. */
  txns?: {
    m5?: DexScreenerTxnCounts;
    h1?: DexScreenerTxnCounts;
    h6?: DexScreenerTxnCounts;
    h24?: DexScreenerTxnCounts;
  };
  info?: { imageUrl?: string };
}

/**
 * Two-stage discovery pipeline (2026-07-22): this client had zero caching,
 * zero in-flight dedup, and no fetch timeout, despite being called from many
 * independent places (riskAnalyzer, priceMonitor, positionManager,
 * migrationMonitor, emergencyExitMonitor) for the same mint within moments of
 * each other — the RPC connection layer already solved this exact problem
 * (see resilientConnection.ts's `cache`/`inFlight` maps); this mirrors that
 * same proven pattern for DexScreener's HTTP calls instead of reinventing it.
 * TTL is deliberately short (a live-trading decision needs fresh data) and
 * separate in scope from RiskAnalyzer's own 60s result cache, which wraps the
 * entire analyze() pipeline for a re-detected mint — this cache instead
 * collapses duplicate HTTP round-trips across different callers within the
 * same handful of seconds.
 */
export class DexScreenerClient {
  private readonly cache = new Map<string, { value: DexScreenerPair[]; cachedAt: number }>();
  private readonly inFlight = new Map<string, Promise<DexScreenerPair[]>>();

  constructor(
    private readonly apiBase: string,
    private readonly cacheTtlMs: number = 2_500,
    private readonly fetchTimeoutMs: number = 4_000,
  ) {}

  private async runCached(key: string, fetcher: () => Promise<DexScreenerPair[]>) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      return cached.value;
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = fetcher()
      .then((value) => {
        this.cache.set(key, { value, cachedAt: Date.now() });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  async getPairsForToken(mint: string): Promise<DexScreenerPair[]> {
    return this.runCached(`pairs:${mint}`, async () => {
      let res: Response;
      try {
        res = await fetch(`${this.apiBase}/token-pairs/v1/solana/${encodeURIComponent(mint)}`, {
          signal: AbortSignal.timeout(this.fetchTimeoutMs),
        });
      } catch (err) {
        // A hung/aborted request degrades to "no data," matching this
        // method's existing 404-to-[] precedent — every caller already
        // treats an empty result as a fallback trigger, never an unhandled
        // hang. A genuine (non-timeout) network error is indistinguishable
        // from a timeout at the fetch layer, so both take this same safe path.
        throw err instanceof Error && err.name === 'TimeoutError'
          ? new DexScreenerTimeoutError(`DexScreener lookup timed out for mint ${mint}`)
          : err;
      }
      if (!res.ok) {
        if (res.status === 404) return [];
        throw new Error(`DexScreener lookup failed: ${res.status}`);
      }
      const data = (await res.json()) as DexScreenerPair[];
      return Array.isArray(data) ? data : [];
    }).catch((err: unknown) => {
      if (err instanceof DexScreenerTimeoutError) return [];
      throw err;
    });
  }

  async searchPairs(query: string): Promise<DexScreenerPair[]> {
    return this.runCached(`search:${query}`, async () => {
      const res = await fetch(`${this.apiBase}/latest/dex/search?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(this.fetchTimeoutMs),
      });
      if (!res.ok) throw new Error(`DexScreener search failed: ${res.status}`);
      const data = (await res.json()) as { pairs?: DexScreenerPair[] };
      return data.pairs ?? [];
    });
  }

  /** Picks the deepest-liquidity Solana pair for a mint, used as the canonical price source. */
  async getBestSolanaPair(mint: string): Promise<DexScreenerPair | undefined> {
    const pairs = (await this.getPairsForToken(mint)).filter((p) => p.chainId === 'solana');
    return pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  }
}

/** Internal-only marker so a fetch timeout can be distinguished from a genuine network error just above. */
class DexScreenerTimeoutError extends Error {}
