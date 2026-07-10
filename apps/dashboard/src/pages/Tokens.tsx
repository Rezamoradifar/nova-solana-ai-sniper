import { useState } from 'react';
import { api } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import { useLiveEvents } from '../lib/useLiveEvents.js';
import type { Token } from '../lib/types.js';

const DEX_FILTERS = ['ALL', 'PUMPFUN', 'RAYDIUM', 'ORCA', 'JUPITER'] as const;

export function Tokens() {
  const [dexFilter, setDexFilter] = useState<(typeof DEX_FILTERS)[number]>('ALL');
  const liveTick = useLiveEvents(['token.created']);

  const { data: tokens } = usePolling(
    () => api.get<Token[]>(`/tokens${dexFilter === 'ALL' ? '' : `?dex=${dexFilter}`}`),
    4000,
    liveTick,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-white">Live Tokens</h1>
        <div className="flex gap-2">
          {DEX_FILTERS.map((dex) => (
            <button
              key={dex}
              onClick={() => setDexFilter(dex)}
              className={dexFilter === dex ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
            >
              {dex}
            </button>
          ))}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Token</th>
              <th>DEX</th>
              <th>Liquidity</th>
              <th>AI Score</th>
              <th>Risk</th>
              <th>Detected</th>
            </tr>
          </thead>
          <tbody>
            {(tokens ?? []).map((token) => (
              <tr key={token.id}>
                <td className="font-mono text-xs">{token.symbol ?? token.mint.slice(0, 10)}</td>
                <td>{token.dex}</td>
                <td>{token.liquidityUsd ? `$${token.liquidityUsd.toLocaleString()}` : '—'}</td>
                <td>{token.aiScore != null ? token.aiScore.toFixed(0) : '—'}</td>
                <td>
                  {token.isHoneypotSuspected ? (
                    <span className="text-loss">⚠ Suspected</span>
                  ) : (
                    <span className="text-profit">OK</span>
                  )}
                </td>
                <td>{new Date(token.createdAt).toLocaleTimeString()}</td>
              </tr>
            ))}
            {tokens?.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-slate-500">
                  No tokens detected yet. The sniper worker populates this feed as pump.fun launches
                  are detected.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
