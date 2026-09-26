import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { sol, timeAgo } from '../lib/format.js';
import type { Position, Trade } from '../lib/types.js';
import { Button, Card, CardSkeleton, TabPanel, Tabs } from '../components/ui/index.js';
import { TopBar } from '../components/TopBar.js';
import { TokenAvatar } from '../components/TokenAvatar.js';
import { PositionCard } from '../components/PositionCard.js';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong loading this.';
}

const PAGE_SIZE = 20;

const STATUS_TONE: Record<Trade['status'], string> = {
  CONFIRMED: 'text-success',
  PENDING: 'text-warning',
  FAILED: 'text-danger',
};

function TradeRow({ trade }: { trade: Trade }) {
  const symbol = trade.token.symbol ?? trade.token.mint.slice(0, 6);
  return (
    <Card className="flex items-center gap-3 p-3.5" static>
      <TokenAvatar
        imageUrl={trade.token.imageUrl}
        symbol={trade.token.symbol}
        mint={trade.token.mint}
        size={32}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-text-primary">
          {trade.side} <span className="text-text-secondary">{symbol}</span>
        </span>
        <span className="text-xs text-text-secondary">{timeAgo(trade.createdAt)}</span>
      </div>
      <div className="flex flex-col items-end">
        <span
          className={`text-sm font-semibold ${trade.side === 'BUY' ? 'text-danger' : 'text-success'}`}
        >
          {trade.side === 'BUY' ? '-' : '+'}
          {sol(trade.amountSol)}
        </span>
        <span className={`text-xs ${STATUS_TONE[trade.status]}`}>{trade.status}</span>
      </div>
    </Card>
  );
}

/**
 * History screen (Increment 4). Real data only: GET /trades (flat,
 * server-capped at 100, no offset param) and GET /positions (no limit at
 * all). Filtering and "Show more" paging below are both client-side over
 * whatever the server already returned — there is no true server-side
 * pagination/filtering to call into (MISSING_APIS.md #7).
 */
export function History() {
  const [tab, setTab] = useState('trades');
  const [tradeFilter, setTradeFilter] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [positionFilter, setPositionFilter] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');
  const [tradePage, setTradePage] = useState(1);
  const [positionPage, setPositionPage] = useState(1);

  const trades = useQuery({
    queryKey: ['trades'],
    queryFn: () => api.get<Trade[]>('/trades'),
  });
  const positions = useQuery({
    queryKey: ['positions'],
    queryFn: () => api.get<Position[]>('/positions'),
  });

  const filteredTrades = useMemo(() => {
    const all = trades.data ?? [];
    return tradeFilter === 'ALL' ? all : all.filter((t) => t.side === tradeFilter);
  }, [trades.data, tradeFilter]);

  const filteredPositions = useMemo(() => {
    const all = positions.data ?? [];
    return positionFilter === 'ALL' ? all : all.filter((p) => p.status === positionFilter);
  }, [positions.data, positionFilter]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar title="History" subtitle="Trades & positions" />

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'trades', label: 'Trades' },
          { value: 'positions', label: 'Positions' },
        ]}
      >
        <TabPanel value="trades" className="mt-4 flex flex-col gap-3">
          <div className="flex gap-2">
            {(['ALL', 'BUY', 'SELL'] as const).map((f) => (
              <button
                key={f}
                onClick={() => {
                  setTradeFilter(f);
                  setTradePage(1);
                }}
                className={`rounded-button px-3 py-1.5 text-xs font-semibold transition-colors ${
                  tradeFilter === f
                    ? 'bg-accent-gradient text-[#07090F]'
                    : 'glass text-text-secondary'
                }`}
              >
                {f === 'ALL' ? 'All' : f === 'BUY' ? 'Buys' : 'Sells'}
              </button>
            ))}
          </div>

          {trades.isLoading ? (
            <div className="flex flex-col gap-2">
              <CardSkeleton />
              <CardSkeleton />
            </div>
          ) : trades.isError ? (
            <Card className="p-5">
              <p className="text-sm text-danger">{errorMessage(trades.error)}</p>
            </Card>
          ) : filteredTrades.length === 0 ? (
            <Card className="p-5">
              <p className="text-sm text-text-secondary">No trades recorded yet.</p>
            </Card>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                {filteredTrades.slice(0, tradePage * PAGE_SIZE).map((trade) => (
                  <TradeRow key={trade.id} trade={trade} />
                ))}
              </div>
              {filteredTrades.length > tradePage * PAGE_SIZE && (
                <Button variant="secondary" onClick={() => setTradePage((p) => p + 1)}>
                  Show more
                </Button>
              )}
            </>
          )}
        </TabPanel>

        <TabPanel value="positions" className="mt-4 flex flex-col gap-3">
          <div className="flex gap-2">
            {(['ALL', 'OPEN', 'CLOSED'] as const).map((f) => (
              <button
                key={f}
                onClick={() => {
                  setPositionFilter(f);
                  setPositionPage(1);
                }}
                className={`rounded-button px-3 py-1.5 text-xs font-semibold transition-colors ${
                  positionFilter === f
                    ? 'bg-accent-gradient text-[#07090F]'
                    : 'glass text-text-secondary'
                }`}
              >
                {f === 'ALL' ? 'All' : f === 'OPEN' ? 'Open' : 'Closed'}
              </button>
            ))}
          </div>

          {positions.isLoading ? (
            <div className="flex flex-col gap-2">
              <CardSkeleton />
              <CardSkeleton />
            </div>
          ) : positions.isError ? (
            <Card className="p-5">
              <p className="text-sm text-danger">{errorMessage(positions.error)}</p>
            </Card>
          ) : filteredPositions.length === 0 ? (
            <Card className="p-5">
              <p className="text-sm text-text-secondary">No positions recorded yet.</p>
            </Card>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                {filteredPositions.slice(0, positionPage * PAGE_SIZE).map((position) => (
                  <PositionCard key={position.id} position={position} />
                ))}
              </div>
              {filteredPositions.length > positionPage * PAGE_SIZE && (
                <Button variant="secondary" onClick={() => setPositionPage((p) => p + 1)}>
                  Show more
                </Button>
              )}
            </>
          )}
        </TabPanel>
      </Tabs>
    </div>
  );
}
