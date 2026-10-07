export const BOT_URL = import.meta.env.VITE_BOT_URL ?? 'https://t.me/GSPBankSniperBot';
export const PUBLIC_API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export const MARKET_TOKENS = [
  { symbol: 'SOL', name: 'Solana', mint: SOL_MINT, color: '#c1ff75' },
  {
    symbol: 'JUP',
    name: 'Jupiter',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    color: '#baf394',
  },
  {
    symbol: 'RAY',
    name: 'Raydium',
    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    color: '#a89bff',
  },
  {
    symbol: 'BONK',
    name: 'Bonk',
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    color: '#ffb972',
  },
  {
    symbol: 'WIF',
    name: 'dogwifhat',
    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    color: '#e5c4a6',
  },
  {
    symbol: 'JTO',
    name: 'Jito',
    mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
    color: '#8cd8ff',
  },
] as const;

export interface MarketPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number; h1?: number; m5?: number };
  txns?: { h24?: { buys: number; sells: number } };
}

export interface MarketToken {
  symbol: string;
  name: string;
  mint: string;
  color: string;
  price: number;
  change: number | null;
  volume: number;
  liquidity: number;
  pairs: MarketPair[];
  tickChangePercent?: number;
  tickDirection?: 'up' | 'down' | 'flat';
  priceUpdatedAt?: number;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

export function selectMarkets(input: unknown): MarketToken[] {
  if (!Array.isArray(input)) throw new Error('Market data is temporarily unavailable.');
  const pairs = input.filter((v): v is MarketPair => {
    if (!v || typeof v !== 'object') return false;
    return (
      v.chainId === 'solana' &&
      typeof v.pairAddress === 'string' &&
      v.pairAddress.trim().length > 0 &&
      typeof v.dexId === 'string' &&
      v.dexId.trim().length > 0 &&
      typeof v.baseToken?.address === 'string' &&
      typeof v.quoteToken?.address === 'string' &&
      v.quoteToken.address.trim().length > 0 &&
      typeof v.priceUsd === 'string' &&
      /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.priceUsd) &&
      Number.isFinite(Number(v.priceUsd)) &&
      Number(v.priceUsd) > 0 &&
      (finiteNumber(v.liquidity?.usd) ?? 0) > 0
    );
  });
  return MARKET_TOKENS.flatMap((token) => {
    const seen = new Set<string>();
    const tokenPairs = pairs
      .filter((p) => {
        if (p.baseToken.address !== token.mint || seen.has(p.pairAddress)) return false;
        seen.add(p.pairAddress);
        return true;
      })
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const deepest = tokenPairs[0];
    if (!deepest) return [];
    return [
      {
        ...token,
        price: Number(deepest.priceUsd),
        change: finiteNumber(deepest.priceChange?.h24) ?? null,
        volume: tokenPairs.reduce(
          (sum, p) => sum + Math.max(0, finiteNumber(p.volume?.h24) ?? 0),
          0,
        ),
        liquidity: tokenPairs.reduce((sum, p) => sum + (finiteNumber(p.liquidity?.usd) ?? 0), 0),
        pairs: tokenPairs,
      },
    ];
  });
}

export async function fetchMarkets(signal?: AbortSignal): Promise<MarketToken[]> {
  const response = await fetch(`${PUBLIC_API_BASE}/public/markets`, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? 'Market source is busy. Retrying shortly.'
        : 'GSP market gateway is temporarily unavailable.',
    );
  return selectMarkets(await response.json());
}

export function money(value: number | undefined, compact = false): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (compact)
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 0.01 ? 8 : value < 1 ? 4 : 2,
  }).format(value);
}

export function pct(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? '—'
    : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function dexLabel(value: string): string {
  return (
    (
      {
        orca: 'Orca',
        raydium: 'Raydium',
        meteora: 'Meteora',
        pumpswap: 'PumpSwap',
        'pump-fun': 'pump.fun',
      } as Record<string, string>
    )[value] ?? value
  );
}

export function poolUrl(pair: MarketPair): string {
  return `https://dexscreener.com/solana/${encodeURIComponent(pair.pairAddress)}`;
}
