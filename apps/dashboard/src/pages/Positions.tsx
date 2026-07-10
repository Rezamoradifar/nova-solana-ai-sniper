import { api } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import { useLiveEvents } from '../lib/useLiveEvents.js';
import type { Position } from '../lib/types.js';

export function Positions() {
  const liveTick = useLiveEvents(['position.updated']);
  const { data: positions } = usePolling(() => api.get<Position[]>('/positions'), 5000, liveTick);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">Positions</h1>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Token</th>
              <th>Status</th>
              <th>Entry Price</th>
              <th>Invested (SOL)</th>
              <th>TP / SL / Trail</th>
              <th>Realized PnL</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {(positions ?? []).map((position) => (
              <tr key={position.id}>
                <td>{position.token.symbol ?? position.token.mint.slice(0, 10)}</td>
                <td>
                  <span className={position.status === 'OPEN' ? 'text-accent' : 'text-slate-400'}>
                    {position.status}
                  </span>
                </td>
                <td>${position.entryPriceUsd.toFixed(6)}</td>
                <td>{position.amountSolInvested.toFixed(4)}</td>
                <td className="text-xs text-slate-400">
                  {position.takeProfitPercent ?? '—'}% / {position.stopLossPercent ?? '—'}% /{' '}
                  {position.trailingStopPercent ?? '—'}%
                </td>
                <td
                  className={
                    (position.realizedPnlUsd ?? 0) >= 0
                      ? 'text-profit'
                      : position.realizedPnlUsd != null
                        ? 'text-loss'
                        : 'text-slate-500'
                  }
                >
                  {position.realizedPnlUsd != null ? `$${position.realizedPnlUsd.toFixed(2)}` : '—'}
                </td>
                <td>{new Date(position.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {positions?.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-slate-500">
                  No positions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
