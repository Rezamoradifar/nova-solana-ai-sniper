import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Sliders, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { numberOrFallback, sol } from '../lib/format.js';
import { haptics } from '../lib/telegram.js';
import type { SnipeConfig } from '../lib/types.js';
import { Button, Card, CardSkeleton } from '../components/ui/index.js';
import { TopBar } from '../components/TopBar.js';
import { SnipeConfigModal } from '../components/SnipeConfigModal.js';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong loading this.';
}

function SnipeConfigRow({ config }: { config: SnipeConfig }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.del(`/snipes/${config.id}`),
    onSuccess: () => {
      haptics.success();
      void queryClient.invalidateQueries({ queryKey: ['snipes'] });
    },
    onError: () => haptics.error(),
  });

  return (
    <Card className="flex items-center gap-3 p-4" static>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06]">
        <Sliders size={16} className="text-text-secondary" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col text-sm">
        <span className="font-medium text-text-primary">{sol(config.buyAmountSol)} per buy</span>
        <span className="text-xs text-text-secondary">
          Min AI {numberOrFallback(config.minAiScore, '0')} · Min liq $
          {numberOrFallback(config.minLiquidityUsd, '0')}
          {config.autoBuyOnLaunch ? ' · Auto-buy' : ''}
        </span>
      </div>
      <button
        onClick={() => remove.mutate()}
        disabled={remove.isPending}
        className="flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition-colors hover:text-danger disabled:opacity-50"
        aria-label="Delete config"
      >
        <Trash2 size={16} />
      </button>
    </Card>
  );
}

/**
 * Settings screen (Increment 4). Real per-token/per-config CRUD via
 * GET/POST/DELETE /snipes — the closest existing concept to "Trading
 * Controls." A single account-level bot on/off + risk-parameter panel is a
 * gap (MISSING_APIS.md #10) and shown below as an honest empty state, not
 * invented.
 */
export function Settings() {
  const [createOpen, setCreateOpen] = useState(false);

  const snipes = useQuery({
    queryKey: ['snipes'],
    queryFn: () => api.get<SnipeConfig[]>('/snipes'),
  });

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar title="Settings" subtitle="Trading controls & snipe configs" />

      <Card className="p-5">
        <span className="text-sm font-semibold text-text-primary">Trading controls</span>
        <p className="mt-1 text-sm text-text-secondary">
          A single account-wide bot on/off switch and global risk parameters aren't available yet —
          trading is configured per snipe config below.
        </p>
      </Card>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-secondary">Snipe configs</h2>
          <Button
            variant="secondary"
            className="!px-3 !py-1.5 text-xs"
            onClick={() => setCreateOpen(true)}
          >
            <span className="inline-flex items-center gap-1">
              <Plus size={14} /> New
            </span>
          </Button>
        </div>

        {snipes.isLoading ? (
          <div className="flex flex-col gap-2">
            <CardSkeleton />
            <CardSkeleton />
          </div>
        ) : snipes.isError ? (
          <Card className="p-5">
            <p className="text-sm text-danger">{errorMessage(snipes.error)}</p>
          </Card>
        ) : !snipes.data || snipes.data.length === 0 ? (
          <Card className="p-5">
            <p className="text-sm text-text-secondary">No snipe configs yet.</p>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {snipes.data.map((config) => (
              <SnipeConfigRow key={config.id} config={config} />
            ))}
          </div>
        )}
      </section>

      <SnipeConfigModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
