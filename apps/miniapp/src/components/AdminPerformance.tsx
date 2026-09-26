import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp } from 'lucide-react';
import { api } from '../lib/api.js';
import type { AdminPerformance, PerformanceBucket } from '../lib/types.js';
import { Card, CardSkeleton } from './ui/index.js';

const signed = (n: number, digits: number, suffix = '') =>
  `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n).toFixed(digits)}${suffix}`;
const tone = (n: number) => (n > 0 ? 'text-success' : n < 0 ? 'text-danger' : 'text-text-primary');

const REASON_LABEL: Record<string, string> = {
  take_profit: 'Take profit',
  stop_loss: 'Stop loss',
  trailing_stop: 'Trailing stop',
  time_stop: 'Time stop',
  emergency: 'Emergency',
  manual_emergency: 'Manual emergency',
  manual: 'Manual',
};

function BucketTable({ title, rows }: { title: string; rows: PerformanceBucket[] }) {
  if (rows.length === 0) return null;
  return (
    <Card className="p-0">
      <p className="px-4 pt-3.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
        {title}
      </p>
      <div className="divide-y divide-white/[0.06]">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="flex-1 truncate text-text-primary">
              {REASON_LABEL[r.key] ?? r.key}
            </span>
            <span className="w-14 text-right font-mono text-xs text-text-secondary">
              {r.wins}/{r.trades}
            </span>
            <span className={`w-20 text-right font-mono font-semibold ${tone(r.netSol)}`}>
              {signed(r.netSol, 4)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Admin-only: real SOL-based results, split paper vs. live. */
export function AdminPerformance() {
  const [mode, setMode] = useState<'paper' | 'live'>('paper');
  const perf = useQuery({
    queryKey: ['admin', 'performance', mode],
    queryFn: () => api.get<AdminPerformance>(`/admin/performance?mode=${mode}&days=30`),
    refetchInterval: 60_000,
  });
  const s = perf.data?.summary;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary">
          <TrendingUp size={14} /> Performance · 30 days
        </h2>
        <div className="glass flex rounded-full p-0.5 text-xs font-semibold">
          {(['paper', 'live'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-full px-3 py-1 ${
                mode === m ? 'bg-accent-gradient text-[#07090F]' : 'text-text-secondary'
              }`}
            >
              {m === 'paper' ? 'Paper' : 'Live'}
            </button>
          ))}
        </div>
      </div>

      {perf.isLoading ? (
        <CardSkeleton />
      ) : perf.isError || !s ? (
        <Card className="p-5">
          <p className="text-sm text-danger">Could not load performance.</p>
        </Card>
      ) : s.trades === 0 ? (
        <Card className="p-5">
          <p className="text-sm text-text-secondary">No closed {mode} trades yet.</p>
        </Card>
      ) : (
        <>
          <Card className="p-5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
              Net result
            </span>
            <p className={`mt-1 font-mono text-3xl font-bold ${tone(s.netSol)}`}>
              {signed(s.netSol, 4, ' SOL')}
            </p>
            <p className={`font-mono text-sm ${tone(s.roiPercent)}`}>
              {signed(s.roiPercent, 1, '%')} on {s.investedSol.toFixed(4)} SOL invested
            </p>
            <div className="mt-4 grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="font-mono text-lg font-bold text-text-primary">
                  {s.winRatePercent.toFixed(0)}%
                </p>
                <p className="text-[11px] text-text-secondary">
                  win rate ({s.wins}/{s.trades})
                </p>
              </div>
              <div>
                <p className="font-mono text-lg font-bold text-success">
                  {signed(s.avgWinPercent, 1, '%')}
                </p>
                <p className="text-[11px] text-text-secondary">avg win</p>
              </div>
              <div>
                <p className="font-mono text-lg font-bold text-danger">
                  {signed(s.avgLossPercent, 1, '%')}
                </p>
                <p className="text-[11px] text-text-secondary">avg loss</p>
              </div>
            </div>
          </Card>
          <BucketTable title="By exit reason" rows={perf.data!.byExitReason} />
          <BucketTable title="By DEX" rows={perf.data!.byDex} />
          <BucketTable title="By hold time" rows={perf.data!.byHoldTime} />
          {perf.data!.excludedInvalid > 0 && (
            <p className="text-[11px] text-text-secondary">
              {perf.data!.excludedInvalid} paper trade(s) from before the 26 Sep fix excluded.
            </p>
          )}
        </>
      )}
    </section>
  );
}
