/**
 * Public DexScreener enrichment (2026-07-28) — a small, standalone read-only
 * HTTP client, deliberately NOT a shared import of apps/api/src/solana/
 * dexscreener.ts: marketing-engine has no code path into trading execution on
 * purpose (see activityFeed/tradeShowcase's own isolation doc comments), and
 * importing the live-trading client here would be a needless coupling for
 * zero benefit — this only ever needs one best-pair lookup per post, with no
 * caching/in-flight-dedup requirement given the minutes-scale posting cadence.
 *
 * Every field is "real or absent" — a failed/timed-out/empty lookup returns
 * undefined and callers omit the enrichment lines entirely rather than
 * showing a placeholder that could read as real.
 */
export interface DexScreenerEnrichment {
  logoUrl: string | undefined;
  liquidityUsd: number | undefined;
  marketCapUsd: number | undefined;
  volume24hUsd: number | undefined;
  priceChangeH1Percent: number | undefined;
  chain: string;
  dexScreenerUrl: string;
}

interface RawDexScreenerPair {
  chainId: string;
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  volume?: { h24?: number };
  priceChange?: { h1?: number };
  info?: { imageUrl?: string };
}

/** Static link, independent of whether the enrichment lookup itself succeeds
 * — the DexScreener page for a mint always resolves at this URL pattern. */
export function dexScreenerTokenUrl(mint: string): string {
  return `https://dexscreener.com/solana/${mint}`;
}

export class MarketDataClient {
  constructor(
    private readonly apiBase: string,
    private readonly fetchTimeoutMs: number = 4_000,
  ) {}

  /** Best (deepest-liquidity) Solana pair for `mint`, mapped to the fields
   * this feed actually shows — undefined on any failure (network, timeout,
   * non-2xx, no Solana pair) so a lookup problem degrades to "no enrichment
   * this time," never a thrown error that would drop the underlying real post. */
  async fetchEnrichment(mint: string): Promise<DexScreenerEnrichment | undefined> {
    let pairs: RawDexScreenerPair[];
    try {
      const res = await fetch(`${this.apiBase}/token-pairs/v1/solana/${encodeURIComponent(mint)}`, {
        signal: AbortSignal.timeout(this.fetchTimeoutMs),
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as unknown;
      pairs = Array.isArray(data) ? (data as RawDexScreenerPair[]) : [];
    } catch {
      return undefined;
    }

    const best = pairs
      .filter((p) => p.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!best) return undefined;

    return {
      logoUrl: best.info?.imageUrl,
      liquidityUsd: best.liquidity?.usd,
      marketCapUsd: best.marketCap ?? best.fdv,
      volume24hUsd: best.volume?.h24,
      priceChangeH1Percent: best.priceChange?.h1,
      chain: 'Solana',
      dexScreenerUrl: dexScreenerTokenUrl(mint),
    };
  }
}
