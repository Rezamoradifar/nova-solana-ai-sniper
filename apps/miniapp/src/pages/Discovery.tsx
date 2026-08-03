import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { isFiniteNumber } from '../lib/format.js';
import type { Token } from '../lib/types.js';
import { Card, CardSkeleton, Skeleton, TabPanel, Tabs } from '../components/ui/index.js';
import { TopBar } from '../components/TopBar.js';
import { DiscoveryTokenCard } from '../components/DiscoveryTokenCard.js';
import { SignalCard } from '../components/SignalCard.js';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong loading this.';
}

type SortKey = 'recent' | 'liquidity' | 'score';
const SORT_LABEL: Record<SortKey, string> = {
  recent: 'Recent',
  liquidity: 'Liquidity',
  score: 'AI score',
};

/**
 * Discovery screen (Increment 4) — Feed + AI Signals tabs, both sourced from
 * the real GET /tokens (no dedicated /discovery or /signals endpoint exists;
 * MISSING_APIS.md #2/#3). Feed is every recently detected token, client-
 * sorted; Signals is the subset that's actually been scored (aiScore not
 * null), sorted by confidence.
 */
export function Discovery() {
  const [tab, setTab] = useState('feed');
  const [sort, setSort] = useState<SortKey>('recent');

  const tokens = useQuery({
    queryKey: ['tokens'],
    queryFn: () => api.get<Token[]>('/tokens'),
  });

  const sortedFeed = useMemo(() => {
    const list = tokens.data ?? [];
    const copy = [...list];
    if (sort === 'liquidity') {
      copy.sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1));
    } else if (sort === 'score') {
      copy.sort((a, b) => (b.aiScore ?? -1) - (a.aiScore ?? -1));
    } else {
      copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return copy;
  }, [tokens.data, sort]);

  const signals = useMemo(
    () =>
      (tokens.data ?? [])
        .filter((t) => isFiniteNumber(t.aiScore))
        .sort((a, b) => (b.aiScore ?? 0) - (a.aiScore ?? 0)),
    [tokens.data],
  );

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar title="Discovery" subtitle="Recently detected tokens" />

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'feed', label: 'Feed' },
          { value: 'signals', label: `AI Signals (${signals.length})` },
        ]}
      >
        <TabPanel value="feed" className="mt-4 flex flex-col gap-3">
          <div className="flex gap-2">
            {(['recent', 'liquidity', 'score'] as const).map((key) => (
              <button
                key={key}
                onClick={() => setSort(key)}
                className={`rounded-button px-3 py-1.5 text-xs font-semibold transition-colors ${
                  sort === key ? 'bg-accent-gradient text-white' : 'glass text-text-secondary'
                }`}
              >
                {SORT_LABEL[key]}
              </button>
            ))}
          </div>

          {tokens.isLoading ? (
            <Skeleton count={5} className="h-40 w-full" />
          ) : tokens.isError ? (
            <Card className="p-5">
              <p className="text-sm text-danger">{errorMessage(tokens.error)}</p>
            </Card>
          ) : sortedFeed.length === 0 ? (
            <Card className="p-5">
              <p className="text-sm text-text-secondary">No tokens detected yet.</p>
            </Card>
          ) : (
            sortedFeed.map((token) => <DiscoveryTokenCard key={token.id} token={token} />)
          )}
        </TabPanel>

        <TabPanel value="signals" className="mt-4 flex flex-col gap-3">
          {tokens.isLoading ? (
            <div className="flex flex-col gap-3">
              <CardSkeleton />
              <CardSkeleton />
            </div>
          ) : tokens.isError ? (
            <Card className="p-5">
              <p className="text-sm text-danger">{errorMessage(tokens.error)}</p>
            </Card>
          ) : signals.length === 0 ? (
            <Card className="p-5">
              <p className="text-sm text-text-secondary">No scored tokens yet.</p>
            </Card>
          ) : (
            signals.map((token) => <SignalCard key={token.id} token={token} />)
          )}
        </TabPanel>
      </Tabs>
    </div>
  );
}
