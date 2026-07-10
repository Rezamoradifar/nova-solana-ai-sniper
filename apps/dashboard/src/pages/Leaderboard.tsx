import { api } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import type { LeaderboardEntry } from '../lib/types.js';

export function Leaderboard() {
  const { data: entries } = usePolling(() => api.get<LeaderboardEntry[]>('/leaderboard'), 15000);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">Leaderboard</h1>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>#</th>
              <th>Wallet</th>
              <th>Closed Trades</th>
              <th>Realized PnL</th>
            </tr>
          </thead>
          <tbody>
            {(entries ?? []).map((entry, i) => (
              <tr key={entry.walletId}>
                <td>{i + 1}</td>
                <td>
                  <div>{entry.label}</div>
                  <div className="font-mono text-xs text-slate-500">
                    {entry.publicKey.slice(0, 12)}…
                  </div>
                </td>
                <td>{entry.closedTrades}</td>
                <td className={entry.realizedPnlUsd >= 0 ? 'text-profit' : 'text-loss'}>
                  ${entry.realizedPnlUsd.toFixed(2)}
                </td>
              </tr>
            ))}
            {entries?.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-slate-500">
                  No closed trades yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
