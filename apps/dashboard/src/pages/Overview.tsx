import { api } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import { useLiveEvents } from '../lib/useLiveEvents.js';
import { StatCard } from '../components/StatCard.js';
import { TradingViewWidget } from '../components/TradingViewWidget.js';
import type { PortfolioSummary, Trade } from '../lib/types.js';

function formatUsd(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function Overview() {
  const liveTick = useLiveEvents(['trade.created', 'position.updated']);
  const { data: portfolio } = usePolling(
    () => api.get<PortfolioSummary[]>('/portfolio'),
    8000,
    liveTick,
  );
  const { data: trades } = usePolling(() => api.get<Trade[]>('/trades'), 5000, liveTick);

  const totals = (portfolio ?? []).reduce(
    (acc, p) => ({
      openPositions: acc.openPositions + p.openPositions,
      investedSol: acc.investedSol + p.totalInvestedSol,
      realizedPnlUsd: acc.realizedPnlUsd + p.realizedPnlUsd,
      unrealizedPnlUsd: acc.unrealizedPnlUsd + p.unrealizedPnlUsd,
    }),
    { openPositions: 0, investedSol: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0 },
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">Overview</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Open Positions" value={String(totals.openPositions)} />
        <StatCard label="Invested" value={`${totals.investedSol.toFixed(3)} SOL`} />
        <StatCard
          label="Realized PnL"
          value={formatUsd(totals.realizedPnlUsd)}
          tone={totals.realizedPnlUsd >= 0 ? 'profit' : 'loss'}
        />
        <StatCard
          label="Unrealized PnL"
          value={formatUsd(totals.unrealizedPnlUsd)}
          tone={totals.unrealizedPnlUsd >= 0 ? 'profit' : 'loss'}
        />
      </div>

      <TradingViewWidget />

      <div className="card">
        <h2 className="mb-4 text-sm font-semibold text-slate-300">Recent Trades</h2>
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Side</th>
                <th>Token</th>
                <th>Amount (SOL)</th>
                <th>Price</th>
                <th>Status</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {(trades ?? []).slice(0, 15).map((trade) => (
                <tr key={trade.id}>
                  <td className={trade.side === 'BUY' ? 'text-profit' : 'text-loss'}>
                    {trade.side}
                  </td>
                  <td>{trade.token.symbol ?? trade.token.mint.slice(0, 8)}</td>
                  <td>{trade.amountSol.toFixed(4)}</td>
                  <td>{trade.priceUsd ? `$${trade.priceUsd.toFixed(6)}` : '—'}</td>
                  <td>{trade.status}</td>
                  <td>{new Date(trade.createdAt).toLocaleString()}</td>
                </tr>
              ))}
              {trades?.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500">
                    No trades yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
