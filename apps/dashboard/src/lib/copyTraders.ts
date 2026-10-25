export type TraderPeriod = '7d' | '30d';
export interface TraderPerformance {
  realizedPnlUsd: number | null;
  roiPct: number | null;
  winRatePct: number | null;
  buys: number | null;
  sells: number | null;
}
export interface CopyTrader {
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
  traders: CopyTrader[];
}
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
export const validTarget = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
export function parseTraders(value: unknown, period: TraderPeriod): TraderSnapshot {
  const data = value as TraderSnapshot | null;
  if (
    !data ||
    data.source !== 'GMGN' ||
    data.chain !== 'solana' ||
    data.period !== period ||
    data.scope !== 'active_smart_money_sample' ||
    !Array.isArray(data.traders) ||
    !['connected', 'partial', 'empty', 'unavailable', 'not_configured'].includes(data.status)
  )
    throw new Error('INVALID_TRADER_FEED');
  return {
    ...data,
    traders: data.traders
      .slice(0, 20)
      .filter((trader) => trader && validTarget(trader.address) && Array.isArray(trader.tags))
      .map((trader) => ({
        ...trader,
        performance: trader.performance
          ? {
              realizedPnlUsd: finite(trader.performance.realizedPnlUsd)
                ? trader.performance.realizedPnlUsd
                : null,
              roiPct: finite(trader.performance.roiPct) ? trader.performance.roiPct : null,
              winRatePct:
                finite(trader.performance.winRatePct) &&
                trader.performance.winRatePct >= 0 &&
                trader.performance.winRatePct <= 100
                  ? trader.performance.winRatePct
                  : null,
              buys: finite(trader.performance.buys) ? trader.performance.buys : null,
              sells: finite(trader.performance.sells) ? trader.performance.sells : null,
            }
          : null,
      })),
  };
}
export function traderDataLive(data: TraderSnapshot | null, now: number) {
  const at = data?.performanceUpdatedAt;
  return Boolean(
    data &&
    (data.status === 'connected' || data.status === 'partial') &&
    finite(at) &&
    at <= now + 5000 &&
    now - at <= 90_000 &&
    data.traders.some((trader) => trader.performance?.realizedPnlUsd != null),
  );
}
export const pnlTone = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) || value === 0
    ? 'is-neutral'
    : value > 0
      ? 'is-profit'
      : 'is-loss';
export function signedValue(value: number | null | undefined, unit: 'USD' | 'SOL' | 'percent') {
  if (value == null || !Number.isFinite(value)) return '—';
  const formatter = new Intl.NumberFormat('en-US', {
    signDisplay: 'exceptZero',
    ...(unit === 'USD'
      ? { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }
      : { maximumFractionDigits: unit === 'SOL' ? 6 : 2 }),
  });
  return formatter.format(value) + (unit === 'SOL' ? ' SOL' : unit === 'percent' ? '%' : '');
}
