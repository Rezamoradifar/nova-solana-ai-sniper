import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Coins, Layers, TrendingDown, TrendingUp, Wallet as WalletIcon } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import {
  isFiniteNumber,
  lamportsToSol,
  numberOrFallback,
  pnlToneClass,
  sol,
  usd,
} from '../lib/format.js';
import { useAuth } from '../lib/AuthContext.js';
import { aggregatePortfolio } from '../lib/portfolio.js';
import type { PortfolioSummary, Position, Token, Wallet } from '../lib/types.js';
import { Card, CardSkeleton, PortfolioChart, Skeleton } from '../components/ui/index.js';
import { TopBar } from '../components/TopBar.js';
import { TokenAvatar } from '../components/TokenAvatar.js';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong loading this.';
}

/**
 * Home screen (Increment 4 — premium rebuild). Wired to real endpoints only:
 * GET /portfolio, /wallets, /tokens, /positions. Discovery/Signals feeds
 * live on their own routes now (see lib/nav.ts); no Discovery/Signals gap
 * endpoint is invented here (MISSING_APIS.md #2, #3).
 */
export function Home() {
  const { user } = useAuth();

  // GET /portfolio returns one summary per wallet — see PortfolioSummaryList's
  // doc comment in lib/types.ts. aggregatePortfolio sums across all of them.
  const portfolio = useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api.get<PortfolioSummary[]>('/portfolio'),
  });
  const totals = useMemo(
    () => (portfolio.data ? aggregatePortfolio(portfolio.data) : undefined),
    [portfolio.data],
  );
  const wallets = useQuery({
    queryKey: ['wallets'],
    queryFn: () => api.get<Wallet[]>('/wallets'),
  });
  const tokens = useQuery({
    queryKey: ['tokens'],
    queryFn: () => api.get<Token[]>('/tokens'),
  });
  const positions = useQuery({
    queryKey: ['positions'],
    queryFn: () => api.get<Position[]>('/positions'),
  });

  const primaryWallet = wallets.data?.find((w) => w.isActive) ?? wallets.data?.[0];

  const netPnlUsd =
    totals && isFiniteNumber(totals.realizedPnlUsd) && isFiniteNumber(totals.unrealizedPnlUsd)
      ? totals.realizedPnlUsd + totals.unrealizedPnlUsd
      : undefined;

  // Real cumulative-realized-PnL-over-time series, derived client-side from
  // closed positions (no /profit time-series endpoint exists — MISSING_APIS.md
  // #8 — this is genuine data client-aggregated, not invented). The final
  // point folds in current unrealizedPnlUsd so the line ends at "now."
  const chart = useMemo(() => {
    if (!positions.data)
      return { points: [] as { time: number; value: number }[], trend: 'flat' as const };
    const closed = positions.data
      .filter((p) => p.status === 'CLOSED' && p.closedAt && isFiniteNumber(p.realizedPnlUsd))
      .sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime());

    let running = 0;
    const points = closed.map((p) => {
      running += p.realizedPnlUsd!;
      return { time: Math.floor(new Date(p.closedAt!).getTime() / 1000), value: running };
    });

    if (totals) {
      const unrealized = isFiniteNumber(totals.unrealizedPnlUsd) ? totals.unrealizedPnlUsd : 0;
      points.push({ time: Math.floor(Date.now() / 1000), value: running + unrealized });
    }

    const first = points[0];
    const last = points[points.length - 1];
    const trend: 'up' | 'down' | 'flat' =
      !first || !last || points.length < 2 ? 'flat' : last.value >= first.value ? 'up' : 'down';

    return { points, trend };
  }, [positions.data, totals]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar
        title={user?.subscriptionTier === 'PRO' ? 'GSP Bank Pro' : 'GSP Bank Sniper'}
        subtitle="Welcome back"
      />

      <section aria-label="Net PnL and portfolio history">
        {portfolio.isLoading || positions.isLoading ? (
          <CardSkeleton />
        ) : portfolio.isError || totals === undefined ? (
          <Card className="p-5">
            <p className="text-sm text-danger">{errorMessage(portfolio.error)}</p>
          </Card>
        ) : (
          <Card className="overflow-hidden p-5 sm:p-6">
            <span className="text-xs uppercase tracking-wide text-text-secondary">Net P&amp;L</span>
            <p className={`mt-1 text-3xl font-extrabold sm:text-4xl ${pnlToneClass(netPnlUsd)}`}>
              {usd(netPnlUsd)}
            </p>
            <p className="mt-0.5 text-xs text-text-secondary">Realized + unrealized, all wallets</p>
            {chart.points.length >= 2 ? (
              <div className="-mx-1 mt-3">
                <PortfolioChart data={chart.points} trend={chart.trend} height={140} />
              </div>
            ) : (
              <div className="mt-4 flex h-[80px] items-center justify-center rounded-input border border-dashed border-surface-border/30">
                <p className="text-xs text-text-secondary">
                  Chart appears after your first closed trade.
                </p>
              </div>
            )}
          </Card>
        )}
      </section>

      <section aria-label="Wallet balance">
        {wallets.isLoading ? (
          <CardSkeleton />
        ) : wallets.isError ? (
          <Card className="p-5">
            <p className="text-sm text-danger">{errorMessage(wallets.error)}</p>
          </Card>
        ) : !primaryWallet ? (
          <Card className="p-5">
            <p className="text-sm text-text-secondary">No wallet connected yet.</p>
          </Card>
        ) : (
          <Card className="flex items-center gap-4 p-5 sm:p-6">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-gradient">
              <WalletIcon size={20} className="text-white" />
            </div>
            <div>
              <span className="text-xs uppercase tracking-wide text-text-secondary">
                {primaryWallet.label} balance
              </span>
              <p className="mt-0.5 text-2xl font-bold text-text-primary sm:text-3xl">
                {sol(lamportsToSol(primaryWallet.lastKnownBalanceLamports))}
              </p>
            </div>
          </Card>
        )}
      </section>

      <section aria-label="Portfolio summary" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-text-secondary">Portfolio</h2>
        {portfolio.isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </div>
        ) : portfolio.isError || totals === undefined ? (
          <Card className="p-5">
            <p className="text-sm text-danger">{errorMessage(portfolio.error)}</p>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card className="p-4 sm:p-5">
              <Layers size={16} className="text-text-secondary" />
              <span className="mt-2 block whitespace-nowrap text-xs uppercase tracking-wide text-text-secondary">
                Open positions
              </span>
              <p className="mt-1 text-xl font-bold text-text-primary">
                {numberOrFallback(totals.openPositions, '0')}
              </p>
            </Card>
            <Card className="p-4 sm:p-5">
              <Coins size={16} className="text-text-secondary" />
              <span className="mt-2 block text-xs uppercase tracking-wide text-text-secondary">
                Invested
              </span>
              <p className="mt-1 text-xl font-bold text-text-primary">
                {sol(totals.totalInvestedSol)}
              </p>
            </Card>
            <Card className="p-4 sm:p-5">
              {(totals.realizedPnlUsd ?? 0) >= 0 ? (
                <TrendingUp size={16} className="text-success" />
              ) : (
                <TrendingDown size={16} className="text-danger" />
              )}
              <span className="mt-2 block whitespace-nowrap text-xs uppercase tracking-wide text-text-secondary">
                Realized PnL
              </span>
              <p className={`mt-1 text-xl font-bold ${pnlToneClass(totals.realizedPnlUsd)}`}>
                {usd(totals.realizedPnlUsd)}
              </p>
            </Card>
            <Card className="p-4 sm:p-5">
              {(netPnlUsd ?? 0) >= 0 ? (
                <TrendingUp size={16} className="text-success" />
              ) : (
                <TrendingDown size={16} className="text-danger" />
              )}
              <span className="mt-2 block text-xs uppercase tracking-wide text-text-secondary">
                Net PnL
              </span>
              <p className={`mt-1 text-xl font-bold ${pnlToneClass(netPnlUsd)}`}>
                {usd(netPnlUsd)}
              </p>
            </Card>
          </div>
        )}
      </section>

      <section aria-label="Recent tokens" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-text-secondary">Recently detected</h2>
        {tokens.isLoading ? (
          <Skeleton count={5} className="h-16 w-full" />
        ) : tokens.isError || tokens.data === undefined ? (
          <Card className="p-5">
            <p className="text-sm text-danger">{errorMessage(tokens.error)}</p>
          </Card>
        ) : tokens.data.length === 0 ? (
          <Card className="p-5">
            <p className="text-sm text-text-secondary">No tokens detected yet.</p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {tokens.data.slice(0, 10).map((token) => (
              <Card key={token.id} className="flex items-center gap-3 p-4" static>
                <TokenAvatar imageUrl={token.imageUrl} symbol={token.symbol} mint={token.mint} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold text-text-primary">
                    {token.symbol ?? token.mint.slice(0, 6)}
                  </span>
                  <span className="text-xs text-text-secondary">{token.dex}</span>
                </div>
                <div className="flex flex-col items-end pl-2">
                  <span className="text-sm font-semibold text-text-primary">
                    {numberOrFallback(token.aiScore, 'No data')}
                  </span>
                  <span className="text-xs text-text-secondary">{usd(token.liquidityUsd, 0)}</span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
