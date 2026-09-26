import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { isFiniteNumber, percent, usd } from '../lib/format.js';
import type { Position } from '../lib/types.js';
import { Card, CardSkeleton } from '../components/ui/index.js';
import { TopBar } from '../components/TopBar.js';
import { TokenAvatar } from '../components/TokenAvatar.js';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong loading this.';
}

/**
 * Portfolio screen (Increment 4) — current holdings composition, distinct
 * from Home (single aggregate PnL numbers) and Positions' Profit Analytics
 * tab (historical trade stats). Real data only: open GET /positions rows,
 * each valued at currentPriceUsd × amountToken (the same live-price fields
 * added to /positions for the Positions screen's live PnL). A position
 * without a live price is shown but excluded from the value total/allocation
 * math rather than guessed at.
 */
export function Portfolio() {
  const positions = useQuery({
    queryKey: ['positions'],
    queryFn: () => api.get<Position[]>('/positions'),
  });

  const holdings = useMemo(() => {
    const open = (positions.data ?? []).filter((p) => p.status === 'OPEN');
    const withValue = open.map((p) => ({
      position: p,
      valueUsd: isFiniteNumber(p.currentPriceUsd) ? p.currentPriceUsd * p.amountToken : undefined,
    }));
    const totalValueUsd = withValue.reduce(
      (sum, h) => sum + (isFiniteNumber(h.valueUsd) ? h.valueUsd : 0),
      0,
    );
    const sorted = [...withValue].sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
    return {
      sorted,
      totalValueUsd,
      hasAnyValue: withValue.some((h) => isFiniteNumber(h.valueUsd)),
    };
  }, [positions.data]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar title="Portfolio" subtitle="Current holdings" />

      <Card className="p-5 sm:p-6">
        <span className="text-xs uppercase tracking-wide text-text-secondary">
          Total holdings value
        </span>
        <p className="mt-1 font-mono text-3xl font-bold text-text-primary sm:text-4xl">
          {holdings.hasAnyValue ? usd(holdings.totalValueUsd) : 'No data'}
        </p>
        <p className="mt-0.5 text-xs text-text-secondary">
          {holdings.sorted.length} open position{holdings.sorted.length === 1 ? '' : 's'}
        </p>
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-text-secondary">Allocation</h2>
        {positions.isLoading ? (
          <div className="flex flex-col gap-2">
            <CardSkeleton />
            <CardSkeleton />
          </div>
        ) : positions.isError ? (
          <Card className="p-5">
            <p className="text-sm text-danger">{errorMessage(positions.error)}</p>
          </Card>
        ) : holdings.sorted.length === 0 ? (
          <Card className="p-5">
            <p className="text-sm text-text-secondary">No open positions right now.</p>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {holdings.sorted.map(({ position, valueUsd }) => {
              const symbol = position.token.symbol ?? position.token.mint.slice(0, 6);
              const allocationPercent =
                isFiniteNumber(valueUsd) && holdings.totalValueUsd > 0
                  ? (valueUsd / holdings.totalValueUsd) * 100
                  : undefined;
              return (
                <Card key={position.id} className="flex items-center gap-3 p-3.5" static>
                  <TokenAvatar
                    imageUrl={position.token.imageUrl}
                    symbol={position.token.symbol}
                    mint={position.token.mint}
                    size={32}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-medium text-text-primary">{symbol}</span>
                    <span className="text-xs text-text-secondary">
                      {position.amountToken.toLocaleString()} tokens
                    </span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-sm font-semibold text-text-primary">
                      {isFiniteNumber(valueUsd) ? usd(valueUsd) : 'No data'}
                    </span>
                    {allocationPercent !== undefined && (
                      <span className="text-xs text-text-secondary">
                        {percent(allocationPercent)}
                      </span>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
