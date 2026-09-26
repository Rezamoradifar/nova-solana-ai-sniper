import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { Activity, Coins, Pencil, Power, Radar, ShieldAlert, Users } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.js';
import { haptics } from '../lib/telegram.js';
import { sol, usd } from '../lib/format.js';
import type { AdminOverview } from '../lib/types.js';
import { TopBar } from '../components/TopBar.js';
import { Button, Card, CardSkeleton, Input, Modal } from '../components/ui/index.js';

type EditField = 'treasury' | 'fee' | 'level1' | 'level2';

const EDIT_COPY: Record<EditField, { title: string; label: string; hint: string }> = {
  treasury: {
    title: 'Treasury wallet',
    label: 'Solana address',
    hint: "The platform's share of every fee is paid to this address. Double-check it — payouts are on-chain and final.",
  },
  fee: {
    title: 'Platform fee',
    label: 'Percent of net profit',
    hint: 'Taken only from profitable trades. Users must accept a new fee before auto-trading continues.',
  },
  level1: {
    title: 'Referral level 1',
    label: 'Percent of net profit',
    hint: 'Paid to the direct referrer, out of the platform fee. 0 disables this level.',
  },
  level2: {
    title: 'Referral level 2',
    label: 'Percent of net profit',
    hint: "Paid to the referrer's referrer, out of the platform fee. 0 disables this level.",
  },
};

function bpsToPct(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;
}

function errorText(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong.';
}

function SectionTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary">
      {icon}
      {children}
    </h2>
  );
}

function Row({
  label,
  value,
  onEdit,
  tone,
}: {
  label: string;
  value: ReactNode;
  onEdit?: () => void;
  tone?: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span className="flex-1 text-sm text-text-secondary">{label}</span>
      <span className={`font-mono text-sm font-semibold ${tone ?? 'text-text-primary'}`}>
        {value}
      </span>
      {onEdit && (
        <button
          type="button"
          onClick={() => {
            haptics.tap();
            onEdit();
          }}
          className="glass flex h-8 w-8 items-center justify-center rounded-full text-text-secondary"
          aria-label={`Edit ${label}`}
        >
          <Pencil size={14} />
        </button>
      )}
    </div>
  );
}

function Toggle({
  label,
  description,
  on,
  danger,
  busy,
  onChange,
}: {
  label: string;
  description: string;
  on: boolean;
  danger?: boolean;
  busy?: boolean;
  onChange: (next: boolean) => void;
}) {
  const activeColor = danger ? 'bg-danger' : 'bg-success';
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-primary">{label}</p>
        <p className="mt-0.5 text-xs text-text-secondary">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={busy}
        onClick={() => {
          haptics.tap();
          onChange(!on);
        }}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
          on ? activeColor : 'bg-white/15'
        }`}
      >
        <span
          className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${
            on ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
        {label}
      </span>
      <p className="mt-1 font-mono text-lg font-bold text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 font-mono text-xs text-text-secondary">{sub}</p>}
    </Card>
  );
}

/**
 * Admin screen — only reachable for TELEGRAM_ADMIN_IDS members (the API
 * enforces this on every request; hiding the entry point is just UX).
 */
export function Admin() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<EditField | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmKill, setConfirmKill] = useState<boolean | null>(null);

  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.get<AdminOverview>('/admin/overview'),
    refetchInterval: 15_000,
    enabled: !!user?.isAdmin,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] });

  const save = useMutation({
    mutationFn: async ({ field, value }: { field: EditField; value: string }) => {
      if (field === 'treasury') return api.put('/admin/settings/treasury', { address: value });
      const percent = Number(value.trim().replace('%', '').replace(',', '.'));
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        throw new Error('Enter a number between 0 and 100.');
      }
      if (field === 'fee') return api.put('/admin/settings/fee', { percent });
      return api.put(`/admin/settings/referral/${field === 'level1' ? 1 : 2}`, { percent });
    },
    onSuccess: () => {
      haptics.success();
      setEditing(null);
      void refresh();
    },
  });

  const toggle = useMutation({
    mutationFn: ({ path, enabled }: { path: string; enabled: boolean }) =>
      api.put(path, { enabled }),
    onSettled: () => void refresh(),
  });

  if (user && !user.isAdmin) return <Navigate to="/" replace />;

  const openEdit = (field: EditField, current: string) => {
    save.reset();
    setDraft(current);
    setEditing(field);
  };

  const data = overview.data;
  const level = (n: number) =>
    data?.settings.referralLevels.find((l) => l.level === n && l.enabled)?.percentBps ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar title="Admin" subtitle="Fees, treasury & controls" />

      {overview.isLoading ? (
        <>
          <CardSkeleton />
          <CardSkeleton />
        </>
      ) : overview.isError || !data ? (
        <Card className="p-5">
          <p className="text-sm text-danger">{errorText(overview.error)}</p>
        </Card>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <SectionTitle icon={<Power size={14} />}>Trading control</SectionTitle>
            <Card className="flex flex-col divide-y divide-white/[0.06] p-0">
              <div className="flex items-center gap-3 px-4 py-3.5">
                <span className="flex-1 text-sm text-text-secondary">Mode</span>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold tracking-wide ${
                    data.trading.mode === 'LIVE'
                      ? 'bg-danger/15 text-danger'
                      : 'bg-warning/15 text-warning'
                  }`}
                >
                  {data.trading.mode === 'LIVE'
                    ? 'LIVE — real money'
                    : data.trading.mode === 'PAPER'
                      ? 'PAPER — simulated'
                      : 'Engine not running'}
                </span>
              </div>
              <Toggle
                label="Auto-buy"
                description={
                  data.trading.autoBuyPaused
                    ? `Paused — ${data.trading.autoBuyPausedReason ?? 'no reason recorded'}`
                    : `Running for ${data.trading.activeSnipeConfigs} active sniper config(s)`
                }
                on={!data.trading.autoBuyPaused}
                busy={toggle.isPending}
                onChange={(enabled) => toggle.mutate({ path: '/admin/trading/auto-buy', enabled })}
              />
              <Toggle
                label="Kill switch"
                description={
                  data.trading.killSwitch
                    ? 'ACTIVE — all new trades are blocked'
                    : 'Off — stops every new trade instantly when turned on'
                }
                on={data.trading.killSwitch}
                danger
                busy={toggle.isPending}
                onChange={(next) => setConfirmKill(next)}
              />
            </Card>
            {toggle.isError && <p className="text-xs text-danger">{errorText(toggle.error)}</p>}
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle icon={<Coins size={14} />}>Fees & treasury</SectionTitle>
            <Card className="flex flex-col divide-y divide-white/[0.06] p-0">
              <div className="flex items-center gap-3 px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text-secondary">Treasury wallet</p>
                  <p className="mt-0.5 font-mono text-sm font-semibold text-text-primary">
                    {short(
                      data.settings.treasuryWalletAddress ?? data.settings.envTreasuryWalletAddress,
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] text-text-secondary">
                    {data.settings.treasuryWalletAddress
                      ? 'Set in admin panel'
                      : 'From server .env'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    openEdit(
                      'treasury',
                      data.settings.treasuryWalletAddress ?? data.settings.envTreasuryWalletAddress,
                    )
                  }
                  className="glass flex h-8 w-8 items-center justify-center rounded-full text-text-secondary"
                  aria-label="Edit treasury wallet"
                >
                  <Pencil size={14} />
                </button>
              </div>
              <Row
                label="Platform fee"
                value={bpsToPct(data.settings.performanceFeeBps)}
                tone="text-success"
                onEdit={() => openEdit('fee', String(data.settings.performanceFeeBps / 100))}
              />
              <Row label="User keeps" value={bpsToPct(10_000 - data.settings.performanceFeeBps)} />
              <Row
                label="Referral level 1"
                value={bpsToPct(level(1))}
                onEdit={() => openEdit('level1', String(level(1) / 100))}
              />
              <Row
                label="Referral level 2"
                value={bpsToPct(level(2))}
                onEdit={() => openEdit('level2', String(level(2) / 100))}
              />
              <Toggle
                label="Referral program"
                description="Referral rewards are paid from the platform fee"
                on={data.settings.referralProgramEnabled}
                busy={toggle.isPending}
                onChange={(enabled) =>
                  toggle.mutate({ path: '/admin/settings/referral-program', enabled })
                }
              />
            </Card>
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle icon={<Users size={14} />}>Business</SectionTitle>
            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Users"
                value={String(data.stats.users)}
                sub={`+${data.stats.newUsers24h} today`}
              />
              <Stat label="Open positions" value={String(data.stats.openPositions)} />
              <Stat
                label="Trades"
                value={String(data.stats.totalTrades)}
                sub={`${data.stats.trades24h} in 24h`}
              />
              <Stat
                label="Volume"
                value={sol(data.stats.volumeSolTotal, 2)}
                sub={`${sol(data.stats.volumeSol24h, 2)} in 24h`}
              />
              <Stat label="Fee revenue" value={usd(data.stats.feeRevenueUsd)} />
              <Stat label="Referral paid" value={usd(data.stats.referralPaidUsd)} />
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle icon={<Radar size={14} />}>System health</SectionTitle>
            <Card className="flex flex-col divide-y divide-white/[0.06] p-0">
              <Row
                label="Launch detection"
                value={data.health.scannerState ?? 'unknown'}
                tone={data.health.scannerState === 'HEALTHY' ? 'text-success' : 'text-warning'}
              />
              <Row label="RPC provider" value={data.health.activeProvider ?? 'unknown'} />
              <Row
                label="Tokens found (10 min)"
                value={String(data.health.tokens10m)}
                tone={data.health.tokens10m > 0 ? 'text-success' : 'text-warning'}
              />
              <Row label="Tokens found (24 h)" value={String(data.health.tokens24h)} />
            </Card>
            <p className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <Activity size={12} /> Refreshes every 15 seconds
            </p>
          </section>
        </>
      )}

      <Modal
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing ? EDIT_COPY[editing].title : ''}
        description={editing ? EDIT_COPY[editing].hint : undefined}
      >
        {editing && (
          <form
            className="mt-4 flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({ field: editing, value: draft });
            }}
          >
            <Input
              label={EDIT_COPY[editing].label}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              inputMode={editing === 'treasury' ? 'text' : 'decimal'}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              error={save.isError ? errorText(save.error) : undefined}
            />
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() => save.mutate({ field: editing, value: draft })}
            >
              Save
            </Button>
          </form>
        )}
      </Modal>

      <Modal
        open={confirmKill !== null}
        onOpenChange={(open) => !open && setConfirmKill(null)}
        title={confirmKill ? 'Turn on the kill switch?' : 'Turn off the kill switch?'}
        description={
          confirmKill
            ? 'Every new trade is blocked immediately, for every user. Open positions keep their exits.'
            : 'New trades will be allowed again.'
        }
      >
        <div className="mt-4 flex flex-col gap-3">
          <Button
            variant={confirmKill ? 'danger' : 'primary'}
            loading={toggle.isPending}
            onClick={() => {
              const enabled = confirmKill === true;
              toggle.mutate(
                { path: '/admin/trading/kill-switch', enabled },
                { onSettled: () => setConfirmKill(null) },
              );
            }}
          >
            <span className="inline-flex items-center gap-2">
              <ShieldAlert size={16} /> {confirmKill ? 'Block all new trades' : 'Allow trading'}
            </span>
          </Button>
          <Button variant="secondary" onClick={() => setConfirmKill(null)}>
            Cancel
          </Button>
        </div>
      </Modal>
    </div>
  );
}
