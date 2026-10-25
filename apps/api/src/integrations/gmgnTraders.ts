import { randomUUID } from 'node:crypto';
import { isValidSolanaPublicKey } from '@nova/shared';
import { fetchGmgnSmartMoney, type GmgnSmartMoneyTrade } from './gmgn.js';

export type TraderPeriod = '7d' | '30d';
export interface TraderPerformance {
  realizedPnlUsd: number | null;
  roiPct: number | null;
  winRatePct: number | null;
  buys: number | null;
  sells: number | null;
}
export interface GmgnTrader {
  address: string;
  name: string | null;
  tags: string[];
  observedTrades: number;
  observedVolumeUsd: number;
  lastActivityAt: number | null;
  performance: TraderPerformance | null;
}
export interface TraderSnapshot {
  source: 'GMGN';
  chain: 'solana';
  scope: 'active_smart_money_sample';
  period: TraderPeriod;
  status: 'connected' | 'partial' | 'empty' | 'unavailable' | 'not_configured';
  updatedAt: number | null;
  performanceUpdatedAt: number | null;
  refreshMs: number;
  traders: GmgnTrader[];
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const numeric = (value: unknown): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const count = (value: unknown) => {
  const n = numeric(value);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;

/** GMGN stats reports USD realized profit and fractional ROI/win rate, never volume PnL. */
export function normalizeTraderStats(input: unknown, addresses: string[], now = Date.now()) {
  const root = record(input);
  if (root && 'code' in root) {
    if (root.code !== 0) throw new Error('GMGN_STATS_UNAVAILABLE');
    input = root.data;
  }
  const data = record(input);
  const rows: unknown[] = Array.isArray(input)
    ? input
    : Array.isArray(data?.list)
      ? data.list
      : Array.isArray(data?.wallets)
        ? data.wallets
        : data?.wallet_address
          ? [data]
          : data
            ? Object.entries(data).flatMap(([address, value]) => {
                const row = record(value);
                return isValidSolanaPublicKey(address) &&
                  row &&
                  (!row.wallet_address || row.wallet_address === address)
                  ? [{ ...row, wallet_address: address }]
                  : [];
              })
            : [];
  const allowed = new Set(addresses);
  const result = new Map<
    string,
    { name: string | null; lastActivityAt: number | null; performance: TraderPerformance }
  >();
  const duplicates = new Set<string>();
  for (const value of rows.slice(0, 100)) {
    const row = record(value);
    const address = row?.wallet_address;
    if (!row || typeof address !== 'string' || !allowed.has(address)) continue;
    if (result.has(address)) {
      duplicates.add(address);
      continue;
    }
    const common = record(row.common);
    const stat = record(row.pnl_stat);
    const profit = numeric(row.realized_profit);
    const cost = numeric(row.realized_profit_cost);
    const roi =
      numeric(row.realized_profit_pnl) ??
      (profit !== null && cost !== null && cost > 0 ? profit / cost : null);
    const win = numeric(stat?.winrate);
    const stamp = numeric(row.last_timestamp);
    result.set(address, {
      name: text(common?.name) ?? text(common?.nick_name) ?? text(common?.twitter_name),
      lastActivityAt:
        stamp !== null && stamp > 0 && stamp * 1000 <= now + 5000 ? stamp * 1000 : null,
      performance: {
        realizedPnlUsd: profit,
        roiPct: roi !== null && Number.isFinite(roi * 100) ? roi * 100 : null,
        winRatePct: win !== null && win >= 0 && win <= 1 ? win * 100 : null,
        buys: count(row.buy),
        sells: count(row.sell),
      },
    });
  }
  for (const address of duplicates) result.delete(address);
  return result;
}

export async function fetchTraderStats(
  apiKey: string,
  addresses: string[],
  period: TraderPeriod,
): Promise<unknown> {
  // The official stats GET returned only the first wallet in a live probe.
  // Use the dedicated batch analytics endpoint for all measured profits.
  const url = new URL('https://openapi.gmgn.ai/v1/user/wallet_profits');
  url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
  url.searchParams.set('client_id', randomUUID());
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-APIKEY': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'GSP-TRADING/1.0',
    },
    body: JSON.stringify({ chain: 'sol', period, wallet_addresses: addresses }),
    signal: AbortSignal.timeout(7500),
  });
  if (!response.ok) throw new Error('GMGN_STATS_UNAVAILABLE');
  const envelope = record(await response.json());
  if (envelope?.code !== 0) throw new Error('GMGN_STATS_UNAVAILABLE');
  const data = record(envelope.data);
  if (!Array.isArray(data?.list)) throw new Error('GMGN_STATS_UNAVAILABLE');
  // Profiles for the three leaders are optional bounded reads. Their names
  // and win rates never overwrite the period's batch profit or cost basis.
  const normalized = normalizeTraderStats(data, addresses);
  const leading = [...normalized.entries()]
    .filter(([, value]) => value.performance.realizedPnlUsd !== null)
    .sort((a, b) => b[1].performance.realizedPnlUsd! - a[1].performance.realizedPnlUsd!)
    .slice(0, 3);
  const profiles = new Map<string, Record<string, unknown>>();
  await Promise.all(
    leading.map(async ([address]) => {
      const profileUrl = new URL('https://openapi.gmgn.ai/v1/user/wallet_stats');
      for (const [key, value] of Object.entries({
        chain: 'sol',
        period,
        wallet_address: address,
        timestamp: String(Math.floor(Date.now() / 1000)),
        client_id: randomUUID(),
      }))
        profileUrl.searchParams.set(key, value);
      try {
        const result = await fetch(profileUrl, {
          headers: {
            'X-APIKEY': apiKey,
            Accept: 'application/json',
            'User-Agent': 'GSP-TRADING/1.0',
          },
          signal: AbortSignal.timeout(2500),
        });
        if (!result.ok) return;
        const body = record(await result.json());
        const profile = record(body?.data);
        if (body?.code === 0 && profile?.wallet_address === address) profiles.set(address, profile);
      } catch {
        /* Keep batch profit; missing name/win-rate stays unknown. */
      }
    }),
  );
  return {
    list: data.list.map((value) => {
      const row = record(value);
      const profile =
        typeof row?.wallet_address === 'string' ? profiles.get(row.wallet_address) : undefined;
      return profile
        ? {
            ...row,
            common: profile.common,
            pnl_stat: profile.pnl_stat,
            last_timestamp: profile.last_timestamp,
          }
        : value;
    }),
  };
}

function candidates(trades: GmgnSmartMoneyTrade[], now: number): GmgnTrader[] {
  const wallets = new Map<string, GmgnTrader>();
  const seen = new Set<string>();
  for (const trade of trades.slice(0, 200)) {
    if (!isValidSolanaPublicKey(trade.maker)) continue;
    const event = `${trade.transactionHash}:${trade.maker}:${trade.tokenAddress}:${trade.side}`;
    if (trade.transactionHash && seen.has(event)) continue;
    seen.add(event);
    const wallet = wallets.get(trade.maker) ?? {
      address: trade.maker,
      name: null,
      tags: [],
      observedTrades: 0,
      observedVolumeUsd: 0,
      lastActivityAt: null,
      performance: null,
    };
    wallet.observedTrades++;
    if (trade.amountUsd !== undefined && Number.isFinite(trade.amountUsd) && trade.amountUsd >= 0)
      wallet.observedVolumeUsd += trade.amountUsd;
    const stamp = trade.timestamp === undefined ? null : trade.timestamp * 1000;
    if (stamp !== null && Number.isFinite(stamp) && stamp > 0 && stamp <= now + 5000)
      wallet.lastActivityAt = Math.max(wallet.lastActivityAt ?? 0, stamp);
    wallet.tags = [
      ...new Set([
        ...wallet.tags,
        ...trade.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.slice(0, 40)),
      ]),
    ].slice(0, 6);
    wallets.set(trade.maker, wallet);
  }
  return [...wallets.values()]
    .sort((a, b) => b.observedVolumeUsd - a.observedVolumeUsd)
    .slice(0, 20);
}

export function createGmgnTraderFeed({
  loadTrades = fetchGmgnSmartMoney,
  loadStats = fetchTraderStats,
  now = Date.now,
}: {
  loadTrades?: typeof fetchGmgnSmartMoney;
  loadStats?: typeof fetchTraderStats;
  now?: () => number;
} = {}) {
  const snapshots = new Map<string, { value: TraderSnapshot; expires: number; retryAt: number }>();
  const pending = new Map<string, Promise<TraderSnapshot>>();
  return async (period: TraderPeriod, apiKey?: string): Promise<TraderSnapshot> => {
    const base = {
      source: 'GMGN' as const,
      chain: 'solana' as const,
      scope: 'active_smart_money_sample' as const,
      period,
      refreshMs: 30_000,
    };
    if (!apiKey?.trim())
      return {
        ...base,
        status: 'not_configured',
        updatedAt: null,
        performanceUpdatedAt: null,
        traders: [],
      };
    const key = `${apiKey}:${period}`;
    const cached = snapshots.get(key);
    if (cached && cached.expires > now()) return cached.value;
    if (cached && cached.retryAt > now()) return { ...cached.value, status: 'unavailable' };
    let request = pending.get(key);
    if (!request) {
      request = (async (): Promise<TraderSnapshot> => {
        let traders: GmgnTrader[] = [];
        try {
          traders = candidates(await loadTrades(apiKey, 100), now());
          if (!traders.length) {
            const value = {
              ...base,
              status: 'empty' as const,
              updatedAt: now(),
              performanceUpdatedAt: null,
              traders,
            };
            snapshots.set(key, { value, expires: now() + 30_000, retryAt: 0 });
            return value;
          }
          const stats = normalizeTraderStats(
            await loadStats(
              apiKey,
              traders.map((t) => t.address),
              period,
            ),
            traders.map((t) => t.address),
            now(),
          );
          traders = traders.map((t) => ({
            ...t,
            ...stats.get(t.address),
            lastActivityAt:
              Math.max(t.lastActivityAt ?? 0, stats.get(t.address)?.lastActivityAt ?? 0) || null,
          }));
          traders.sort(
            (a, b) =>
              Number(
                b.performance?.realizedPnlUsd !== null &&
                  b.performance?.realizedPnlUsd !== undefined,
              ) -
                Number(
                  a.performance?.realizedPnlUsd !== null &&
                    a.performance?.realizedPnlUsd !== undefined,
                ) ||
              (b.performance?.realizedPnlUsd ?? 0) - (a.performance?.realizedPnlUsd ?? 0) ||
              b.observedVolumeUsd - a.observedVolumeUsd,
          );
          const complete = traders.every(
            (t) =>
              t.performance?.realizedPnlUsd !== null && t.performance?.realizedPnlUsd !== undefined,
          );
          const hasProfit = traders.some(
            (t) =>
              t.performance?.realizedPnlUsd !== null && t.performance?.realizedPnlUsd !== undefined,
          );
          const value: TraderSnapshot = {
            ...base,
            status: complete ? 'connected' : 'partial',
            updatedAt: now(),
            performanceUpdatedAt: hasProfit ? now() : null,
            traders,
          };
          snapshots.set(key, { value, expires: now() + 60_000, retryAt: 0 });
          return value;
        } catch {
          // Preserve the original observation clock; a failed poll never renews old profits.
          const value: TraderSnapshot = cached?.value ?? {
            ...base,
            status: 'unavailable',
            updatedAt: null,
            performanceUpdatedAt: null,
            traders,
          };
          if (snapshots.size > 4) snapshots.clear();
          snapshots.set(key, { value, expires: 0, retryAt: now() + 60_000 });
          return { ...value, status: 'unavailable' };
        }
      })().finally(() => {
        pending.delete(key);
      });
      pending.set(key, request);
    }
    return request;
  };
}
