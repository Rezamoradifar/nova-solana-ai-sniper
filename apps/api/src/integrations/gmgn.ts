import { randomUUID } from 'node:crypto';

const GMGN_HOST = 'https://openapi.gmgn.ai';
const CACHE_TTL_MS = 15_000;

export interface GmgnSmartMoneyTrade {
  transactionHash: string;
  maker: string;
  side: 'buy' | 'sell' | 'unknown';
  tokenAddress: string;
  tokenSymbol: string;
  launchpad?: string;
  amountUsd?: number;
  tokenAmount?: number;
  priceUsd?: number;
  buyCostUsd?: number;
  isClose?: boolean;
  timestamp?: number;
  twitterUsername?: string;
  tags: string[];
}

interface CacheValue {
  expiresAt: number;
  trades: GmgnSmartMoneyTrade[];
}

let cache: CacheValue | undefined;

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeGmgnSmartMoney(input: unknown): GmgnSmartMoneyTrade[] {
  if (!input || typeof input !== 'object') return [];
  const list = (input as { list?: unknown }).list;
  if (!Array.isArray(list)) return [];

  return list.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const maker = asString(row.maker);
    const tokenAddress = asString(row.base_address);
    if (!maker || !tokenAddress) return [];

    const baseToken =
      row.base_token && typeof row.base_token === 'object'
        ? (row.base_token as Record<string, unknown>)
        : {};
    const makerInfo =
      row.maker_info && typeof row.maker_info === 'object'
        ? (row.maker_info as Record<string, unknown>)
        : {};
    const rawTags = makerInfo.tags;

    return [
      {
        transactionHash: asString(row.transaction_hash),
        maker,
        side: row.side === 'buy' || row.side === 'sell' ? row.side : 'unknown',
        tokenAddress,
        tokenSymbol: asString(baseToken.symbol) || '—',
        launchpad: asString(baseToken.launchpad) || undefined,
        amountUsd: asNumber(row.amount_usd),
        tokenAmount: asNumber(row.token_amount),
        priceUsd: asNumber(row.price_usd),
        buyCostUsd: asNumber(row.buy_cost_usd),
        isClose: row.is_open_or_close === 1 || row.is_open_or_close === '1',
        timestamp: asNumber(row.timestamp),
        twitterUsername: asString(makerInfo.twitter_username) || undefined,
        tags: Array.isArray(rawTags)
          ? rawTags.filter((value): value is string => typeof value === 'string').slice(0, 8)
          : [],
      },
    ];
  });
}

export async function fetchGmgnSmartMoney(
  apiKey: string,
  limit = 50,
  now = Date.now(),
): Promise<GmgnSmartMoneyTrade[]> {
  if (cache && cache.expiresAt > now) return cache.trades;

  const url = new URL('/v1/user/smartmoney', GMGN_HOST);
  url.searchParams.set('chain', 'sol');
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 200)));
  url.searchParams.set('timestamp', String(Math.floor(now / 1000)));
  url.searchParams.set('client_id', randomUUID());

  const response = await fetch(url, {
    headers: {
      'X-APIKEY': apiKey,
      Accept: 'application/json',
      'User-Agent': 'GSP-TRADEING/1.0',
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`GMGN Smart Money failed: HTTP ${response.status}`);

  const envelope = (await response.json()) as {
    code?: unknown;
    data?: unknown;
    error?: unknown;
    message?: unknown;
  };
  if (envelope.code !== 0) {
    throw new Error(
      `GMGN Smart Money failed: ${String(envelope.error ?? envelope.message ?? envelope.code)}`,
    );
  }

  const trades = normalizeGmgnSmartMoney(envelope.data);
  cache = { trades, expiresAt: now + CACHE_TTL_MS };
  return trades;
}
