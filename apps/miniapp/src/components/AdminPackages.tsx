import { useQuery } from '@tanstack/react-query';
import { Gem } from 'lucide-react';
import { api } from '../lib/api.js';
import { Card, CardSkeleton } from './ui/index.js';

interface AdminPlan {
  key: string;
  name: string;
  priceSol: number;
  durationDays: number;
  feeBps: number | null;
  maxBuySol: number | null;
  maxOpenPositions: number | null;
  active: boolean;
  activeSubscribers: number;
  sales: number;
  revenueSol: number;
  sales30d: number;
  revenue30dSol: number;
}

interface AdminPlansResponse {
  totals: {
    users: number;
    paidSubscribers: number;
    freeUsers: number;
    revenueSol: number;
    revenue30dSol: number;
    sales: number;
  };
  plans: AdminPlan[];
  recent: {
    planKey: string;
    amountSol: number;
    telegramId: string | null;
    txSignature: string;
    createdAt: string;
  }[];
}

const sol = (n: number) => `${Number(n.toFixed(3))} SOL`;

/** Owner view: every package with subscribers, sales and revenue. Edit in the bot's /admin. */
export function AdminPackages() {
  const q = useQuery({
    queryKey: ['admin', 'plans'],
    queryFn: () => api.get<AdminPlansResponse>('/admin/plans'),
    refetchInterval: 60_000,
  });
  const t = q.data?.totals;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary">
        <Gem size={14} /> Packages & revenue
      </h2>
      {q.isLoading || !t ? (
        <CardSkeleton />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            {[
              ['Revenue', sol(t.revenueSol)],
              ['30 days', sol(t.revenue30dSol)],
              ['Paid users', `${t.paidSubscribers}/${t.users}`],
            ].map(([label, value]) => (
              <Card key={label} className="p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                  {label}
                </p>
                <p className="mt-1 font-mono text-sm font-semibold text-text-primary">{value}</p>
              </Card>
            ))}
          </div>
          {q.data!.plans.map((p) => (
            <Card key={p.key} className="flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-text-primary">
                  {p.name}{' '}
                  {!p.active && <span className="text-xs text-text-secondary">(hidden)</span>}
                </p>
                <p className="font-mono text-sm text-success">
                  {p.priceSol > 0 ? `${p.priceSol} SOL / ${p.durationDays}d` : 'Free'}
                </p>
              </div>
              <p className="text-xs text-text-secondary">
                Fee {p.feeBps !== null ? `${p.feeBps / 100}%` : 'global'} · Max buy{' '}
                {p.maxBuySol ?? '∞'} · Max open {p.maxOpenPositions ?? '∞'}
              </p>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div>
                  <p className="text-text-secondary">Subscribers</p>
                  <p className="font-mono font-semibold text-text-primary">{p.activeSubscribers}</p>
                </div>
                <div>
                  <p className="text-text-secondary">Sales</p>
                  <p className="font-mono font-semibold text-text-primary">
                    {p.sales} <span className="text-text-secondary">({p.sales30d} 30d)</span>
                  </p>
                </div>
                <div>
                  <p className="text-text-secondary">Revenue</p>
                  <p className="font-mono font-semibold text-success">{sol(p.revenueSol)}</p>
                </div>
              </div>
            </Card>
          ))}
          {q.data!.recent.length > 0 && (
            <Card className="p-0">
              <p className="px-4 pt-3.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                Recent purchases
              </p>
              <div className="divide-y divide-white/[0.06]">
                {q.data!.recent.slice(0, 8).map((r) => (
                  <a
                    key={r.txSignature}
                    href={`https://solscan.io/tx/${r.txSignature}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 px-4 py-2.5 text-sm"
                  >
                    <span className="flex-1 truncate text-text-primary">{r.planKey}</span>
                    <span className="font-mono text-xs text-text-secondary">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </span>
                    <span className="w-20 text-right font-mono font-semibold text-success">
                      {sol(r.amountSol)}
                    </span>
                  </a>
                ))}
              </div>
            </Card>
          )}
          <p className="text-center text-[11px] text-text-secondary">
            Edit prices, fees and limits in the bot: /admin → 💎 Packages
          </p>
        </>
      )}
    </section>
  );
}
