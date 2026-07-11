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

export class DexScreenerClient {
  constructor(private readonly apiBase: string) {}

  async getPairsForToken(mint: string): Promise<DexScreenerPair[]> {
    const res = await fetch(`${this.apiBase}/token-pairs/v1/solana/${encodeURIComponent(mint)}`);
    if (!res.ok) {
      if (res.status === 404) return [];
      throw new Error(`DexScreener lookup failed: ${res.status}`);
    }
    const data = (await res.json()) as DexScreenerPair[];
    return Array.isArray(data) ? data : [];
  }

  async searchPairs(query: string): Promise<DexScreenerPair[]> {
    const res = await fetch(`${this.apiBase}/latest/dex/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`DexScreener search failed: ${res.status}`);
    const data = (await res.json()) as { pairs?: DexScreenerPair[] };
    return data.pairs ?? [];
  }

  /** Picks the deepest-liquidity Solana pair for a mint, used as the canonical price source. */
  async getBestSolanaPair(mint: string): Promise<DexScreenerPair | undefined> {
    const pairs = (await this.getPairsForToken(mint)).filter((p) => p.chainId === 'solana');
    return pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  }
}
