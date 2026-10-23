import { api } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import { useLiveEvents } from '../lib/useLiveEvents.js';
import type { Trade } from '../lib/types.js';
import { useLanguage } from '../lib/LanguageContext.js';

export function Logs() {
  const { t: localize } = useLanguage();
  const liveTick = useLiveEvents(['trade.created']);
  const { data: trades } = usePolling(() => api.get<Trade[]>('/trades'), 5000, liveTick);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">{localize('Logs')}</h1>

      <div className="card overflow-x-auto">
        <table className="table-base font-mono text-xs">
          <thead>
            <tr>
              <th>{localize('Time')}</th>
              <th>{localize('Side')}</th>
              <th>{localize('Token')}</th>
              <th>{localize('Status')}</th>
              <th>{localize('Signature')}</th>
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
                  {localize('No activity logged yet.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
