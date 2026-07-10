import { api } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import type { Trade } from '../lib/types.js';

export function Logs() {
  const { data: trades } = usePolling(() => api.get<Trade[]>('/trades'), 5000);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">Logs</h1>

      <div className="card overflow-x-auto">
        <table className="table-base font-mono text-xs">
          <thead>
            <tr>
              <th>Time</th>
              <th>Side</th>
              <th>Token</th>
              <th>Status</th>
              <th>Signature</th>
            </tr>
          </thead>
          <tbody>
            {(trades ?? []).map((trade) => (
              <tr key={trade.id}>
                <td>{new Date(trade.createdAt).toISOString()}</td>
                <td className={trade.side === 'BUY' ? 'text-profit' : 'text-loss'}>{trade.side}</td>
                <td>{trade.token.symbol ?? trade.token.mint.slice(0, 10)}</td>
                <td>{trade.status}</td>
                <td>
                  {trade.txSignature ? (
                    <a
                      href={`https://solscan.io/tx/${trade.txSignature}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline"
                    >
                      {trade.txSignature.slice(0, 16)}…
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {trades?.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-slate-500">
                  No activity logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
