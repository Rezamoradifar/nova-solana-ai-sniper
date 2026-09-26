import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Award, Percent, Target, TrendingDown } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { isFiniteNumber, percent, pnlToneClass, usd } from '../lib/format.js';
import type { Position } from '../lib/types.js';
import { Card, CardSkeleton, PortfolioChart } from './ui/index.js';
import { TokenAvatar } from './TokenAvatar.js';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong loading this.';
}

type RangeKey = '7d' | '30d' | 'all';
const RANGE_DAYS: Record<RangeKey, number | undefined> = { '7d': 7, '30d': 30, all: undefined };

/**
 * Real analytics derived entirely client-side from closed GET /positions
 * rows — no /profit time-series endpoint exists on the backend
 * (MISSING_APIS.md #8). Every number here is a genuine aggregation of real
 * trade history, not invented; a position with a missing/non-finite
 * realizedPnlUsd is excluded from the math rather than treated as 0, so a
 * data gap can never silently understate performance.
 */
export function ProfitAnalytics() {
  const [range, setRange] = useState<RangeKey>('30d');
  const positions = useQuery({
    queryKey: ['positions'],
    queryFn: () => api.get<Position[]>('/positions'),
  });

  const stats = useMemo(() => {
    const all = positions.data ?? [];
    const days = RANGE_DAYS[range];
    const cutoff = days ? Date.now() - days * 86_400_000 : undefined;

    const closed = all
      .filter((p) => p.status === 'CLOSED' && p.closedAt && isFiniteNumber(p.realizedPnlUsd))
      .filter((p) => !cutoff || new Date(p.closedAt!).getTime() >= cutoff)
      .sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime());

    let running = 0;
    const points = closed.map((p) => {
      running += p.realizedPnlUsd!;
      return { time: Math.floor(new Date(p.closedAt!).getTime() / 1000), value: running };
    });

    const totalRealized = closed.reduce((sum, p) => sum + p.realizedPnlUsd!, 0);
    const wins = closed.filter((p) => p.realizedPnlUsd! > 0);
    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : undefined;
    const avgPnl = closed.length > 0 ? totalRealized / closed.length : undefined;
    const best = closed.reduce<Position | undefined>(
      (m, p) => (!m || p.realizedPnlUsd! > m.realizedPnlUsd! ? p : m),
      undefined,
    );
    const worst = closed.reduce<Position | undefined>(
      (m, p) => (!m || p.realizedPnlUsd! < m.realizedPnlUsd! ? p : m),
      undefined,
    );

    const first = points[0];
    const last = points[points.length - 1];
    const trend: 'up' | 'down' | 'flat' =
      !first || !last || points.length < 2 ? 'flat' : last.value >= first.value ? 'up' : 'down';

    return { closed, points, trend, totalRealized, winRate, avgPnl, best, worst };
  }, [positions.data, range]);

  if (positions.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <CardSkeleton />
        <div className="grid grid-cols-2 gap-3">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    );
  }

  if (positions.isError) {
    return (
      <Card className="p-5">
        <p className="text-sm text-danger">{errorMessage(positions.error)}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        {(['7d', '30d', 'all'] as const).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`rounded-button px-3 py-1.5 text-xs font-semibold transition-colors ${
              range === r ? 'bg-accent-gradient text-[#07090F]' : 'glass text-text-secondary'
            }`}
          >
            {r === '7d' ? '7D' : r === '30d' ? '30D' : 'All'}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden p-5">
        <span className="text-xs uppercase tracking-wide text-text-secondary">
          Realized PnL ({stats.closed.length} closed trade{stats.closed.length === 1 ? '' : 's'})
        </span>
        <p className={`mt-1 font-mono text-2xl font-bold ${pnlToneClass(stats.totalRealized)}`}>
          {usd(stats.totalRealized)}
        </p>
        {stats.points.length >= 2 ? (
          <div className="-mx-1 mt-3">
            <PortfolioChart data={stats.points} trend={stats.trend} height={140} />
          </div>
        ) : (
          <div className="mt-4 flex h-[80px] items-center justify-center rounded-input border border-dashed border-surface-border/30">
            <p className="text-xs text-text-secondary">
              Not enough closed trades in this range yet.
            </p>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-4">
          <Percent size={16} className="text-text-secondary" />
          <span className="mt-2 block text-xs uppercase tracking-wide text-text-secondary">
            Win rate
          </span>
          <p className="mt-1 text-xl font-bold text-text-primary">{percent(stats.winRate, 0)}</p>
        </Card>
        <Card className="p-4">
          <Target size={16} className="text-text-secondary" />
          <span className="mt-2 block text-xs uppercase tracking-wide text-text-secondary">
            Avg / trade
          </span>
          <p className={`mt-1 text-xl font-bold ${pnlToneClass(stats.avgPnl)}`}>
            {usd(stats.avgPnl)}
          </p>
        </Card>
      </div>

      {stats.best && (
        <Card className="flex items-center gap-3 p-4">
          <Award size={18} className="shrink-0 text-success" />
          <TokenAvatar
            imageUrl={stats.best.token.imageUrl}
            symbol={stats.best.token.symbol}
            mint={stats.best.token.mint}
            size={32}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs text-text-secondary">Best trade</span>
            <span className="truncate text-sm font-semibold text-text-primary">
              {stats.best.token.symbol ?? stats.best.token.mint.slice(0, 6)}
            </span>
          </div>
          <span className="text-sm font-bold text-success">{usd(stats.best.realizedPnlUsd)}</span>
        </Card>
      )}

      {stats.worst && stats.worst.id !== stats.best?.id && (
        <Card className="flex items-center gap-3 p-4">
          <TrendingDown size={18} className="shrink-0 text-danger" />
          <TokenAvatar
            imageUrl={stats.worst.token.imageUrl}
            symbol={stats.worst.token.symbol}
            mint={stats.worst.token.mint}
            size={32}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs text-text-secondary">Worst trade</span>
            <span className="truncate text-sm font-semibold text-text-primary">
              {stats.worst.token.symbol ?? stats.worst.token.mint.slice(0, 6)}
            </span>
          </div>
          <span className="text-sm font-bold text-danger">{usd(stats.worst.realizedPnlUsd)}</span>
        </Card>
      )}
    </div>
  );
}
