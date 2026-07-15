import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import type { Position } from '../lib/types.js';
import { Card, CardSkeleton, Tabs, TabPanel } from '../components/ui/index.js';
import { TopBar } from '../components/TopBar.js';
import { PositionCard } from '../components/PositionCard.js';
import { SellActionModal, type SellMode } from '../components/SellActionModal.js';
import { ProfitAnalytics } from '../components/ProfitAnalytics.js';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong loading this.';
}

/**
 * Positions screen (Increment 4). GET /positions now returns live
 * currentPriceUsd/unrealizedPnlUsd for OPEN rows (2026-07-14 fix — see
 * MISSING_APIS.md's #4 note and apps/api/src/routes/positions.ts). Sell/
 * Partial Sell/Emergency Sell call the real POST /positions/:id/* routes —
 * every action here moves real funds.
 */
export function Positions() {
  const [tab, setTab] = useState('open');
  const [actionTarget, setActionTarget] = useState<{ position: Position; mode: SellMode } | null>(
    null,
  );

  const positions = useQuery({
    queryKey: ['positions'],
    queryFn: () => api.get<Position[]>('/positions'),
  });

  const { open, closed } = useMemo(() => {
    const all = positions.data ?? [];
    return {
      open: all.filter((p) => p.status === 'OPEN'),
      closed: all.filter((p) => p.status === 'CLOSED'),
    };
  }, [positions.data]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar title="Positions" subtitle="Live PnL across every wallet" />

      {positions.isLoading ? (
        <div className="flex flex-col gap-3">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : positions.isError ? (
        <Card className="p-5">
          <p className="text-sm text-danger">{errorMessage(positions.error)}</p>
        </Card>
      ) : (
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'open', label: `Open (${open.length})` },
            { value: 'closed', label: `Closed (${closed.length})` },
            { value: 'analytics', label: 'Analytics' },
          ]}
        >
          <TabPanel value="open" className="mt-4 flex flex-col gap-3">
            {open.length === 0 ? (
              <Card className="p-5">
                <p className="text-sm text-text-secondary">No open positions right now.</p>
              </Card>
            ) : (
              open.map((position) => (
                <PositionCard
                  key={position.id}
                  position={position}
                  onAction={(mode) => setActionTarget({ position, mode })}
                />
              ))
            )}
          </TabPanel>
          <TabPanel value="closed" className="mt-4 flex flex-col gap-3">
            {closed.length === 0 ? (
              <Card className="p-5">
                <p className="text-sm text-text-secondary">No closed positions yet.</p>
              </Card>
            ) : (
              closed.map((position) => <PositionCard key={position.id} position={position} />)
            )}
          </TabPanel>
          <TabPanel value="analytics" className="mt-4">
            <ProfitAnalytics />
          </TabPanel>
        </Tabs>
      )}

      <SellActionModal
        position={actionTarget?.position ?? null}
        mode={actionTarget?.mode ?? 'sell'}
        onOpenChange={(next) => {
          if (!next) setActionTarget(null);
        }}
      />
    </div>
  );
}
