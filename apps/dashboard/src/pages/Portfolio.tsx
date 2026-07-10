import { api } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import { StatCard } from '../components/StatCard.js';
import type { PortfolioSummary } from '../lib/types.js';

export function Portfolio() {
  const { data: portfolio } = usePolling(() => api.get<PortfolioSummary[]>('/portfolio'), 8000);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">Portfolio</h1>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {(portfolio ?? []).map((p) => (
          <div key={p.walletId} className="card space-y-3">
            <div className="text-xs text-slate-500">Wallet {p.walletId.slice(0, 12)}</div>
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Open Positions" value={String(p.openPositions)} />
              <StatCard label="Invested" value={`${p.totalInvestedSol.toFixed(3)} SOL`} />
              <StatCard
                label="Realized PnL"
                value={`$${p.realizedPnlUsd.toFixed(2)}`}
                tone={p.realizedPnlUsd >= 0 ? 'profit' : 'loss'}
              />
              <StatCard
                label="Unrealized PnL"
                value={`$${p.unrealizedPnlUsd.toFixed(2)}`}
                tone={p.unrealizedPnlUsd >= 0 ? 'profit' : 'loss'}
              />
            </div>
          </div>
        ))}
        {portfolio?.length === 0 && (
          <div className="card col-span-2 py-6 text-center text-slate-500">
            No wallets yet — add one under Wallets to start tracking portfolio performance.
          </div>
        )}
      </div>
    </div>
  );
}
