import { useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';

type Page<T> = { total: number; rows: T[] };
type UserRow = {
  id: string;
  email: string | null;
  telegramId: string | null;
  role: 'ADMIN' | 'TRADER';
  planKey: string;
  telegramActive: boolean;
  isSuspended: boolean;
  suspendedAt: string | null;
  suspensionReason: string | null;
  deletedAt: string | null;
  createdAt: string;
  _count: { wallets: number; snipeConfigs: number; copyConfigs: number };
};
type UserDetail = UserRow & {
  language: string;
  referralCode: string | null;
  wallets: Array<{
    id: string;
    label: string;
    publicKey: string;
    isActive: boolean;
    lastKnownBalanceLamports: string | null;
    _count: { positions: number; trades: number; ledgerEntries: number };
  }>;
  snipeConfigs: Array<{ id: string; isActive: boolean; buyAmountSol: number; autoBuyOnLaunch: boolean }>;
  copyConfigs: Array<{ id: string; targetAddress: string; isActive: boolean }>;
  subscriptions: Array<{ id: string; planKey: string; amountSol: number; expiresAt: string }>;
};

const short = (v: string) => (v.length > 16 ? v.slice(0, 8) + '…' + v.slice(-5) : v);
const err = (e: unknown) => e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Request failed';

export function UserManagement() {
  const [refresh, setRefresh] = useState(0);
  const q = usePolling(() => api.get<Page<UserRow>>('/admin/users?limit=100'), 15_000, refresh);
  const [selected, setSelected] = useState<UserDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    try {
      await action();
      setRefresh((v) => v + 1);
      if (selected?.id === id) setSelected(await api.get<UserDetail>('/admin/users/' + id));
    } catch (e) {
      window.alert(err(e));
    } finally {
      setBusy(null);
    }
  }

  const status = (u: UserRow) => u.deletedAt ? 'Deleted' : u.isSuspended ? 'Suspended' : 'Active';

  async function view(id: string) {
    try { setSelected(await api.get<UserDetail>('/admin/users/' + id)); }
    catch (e) { window.alert(err(e)); }
  }

  async function suspend(u: UserRow) {
    const reason = window.prompt('Suspension reason:', u.suspensionReason ?? 'Manual admin suspension');
    if (reason === null) return;
    await run(u.id, () => api.post('/admin/users/' + u.id + '/suspend', { reason }));
  }

  async function resume(u: UserRow) {
    if (!window.confirm('Resume account access? Trading configs remain paused until separately enabled.')) return;
    await run(u.id, () => api.post('/admin/users/' + u.id + '/resume'));
  }

  async function role(u: UserRow) {
    const next = u.role === 'ADMIN' ? 'TRADER' : 'ADMIN';
    if (!window.confirm('Change this account role to ' + next + '?')) return;
    await run(u.id, () => api.put('/admin/users/' + u.id + '/role', { role: next }));
  }

  async function plan(u: UserRow) {
    const planKey = window.prompt('Plan key:', u.planKey);
    if (!planKey) return;
    await run(u.id, () => api.put('/admin/users/' + u.id + '/plan', { planKey }));
  }

  async function remove(u: UserRow) {
    if (!window.confirm('Delete this account? Accounts with wallet/financial history are protected and will be refused.')) return;
    if (window.prompt('Type DELETE to confirm:') !== 'DELETE') return;
    await run(u.id, () => api.del('/admin/users/' + u.id + '?confirm=DELETE'));
    if (selected?.id === u.id) setSelected(null);
  }

  return <div className="space-y-4">
    <section className="card overflow-x-auto">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-white">User Management · {q.data?.total ?? 0}</h2>
        <p className="text-xs text-slate-500">Suspend blocks login/API access. Delete is protected when wallet or financial history exists.</p>
      </div>
      <table className="table-base min-w-[1180px]">
        <thead><tr><th>User</th><th>Status</th><th>Role</th><th>Plan</th><th>Wallets</th><th>Snipes</th><th>Copy</th><th>Telegram</th><th>Trading</th><th>Account</th></tr></thead>
        <tbody>{(q.data?.rows ?? []).map((u) => <tr key={u.id}>
          <td><button onClick={() => void view(u.id)} className="text-left text-violet-300 hover:underline">{u.email ?? u.telegramId ?? short(u.id)}</button><div className="text-[11px] text-slate-500">{short(u.id)}</div></td>
          <td className={u.deletedAt ? 'text-slate-500' : u.isSuspended ? 'text-amber-300' : 'text-profit'}>{status(u)}</td>
          <td><button disabled={Boolean(u.deletedAt)||busy===u.id} className="text-xs text-violet-300" onClick={() => void role(u)}>{u.role}</button></td>
          <td><button disabled={Boolean(u.deletedAt)||busy===u.id} className="text-xs text-violet-300" onClick={() => void plan(u)}>{u.planKey}</button></td>
          <td>{u._count.wallets}</td><td>{u._count.snipeConfigs}</td><td>{u._count.copyConfigs}</td>
          <td>{u.telegramActive ? 'Active' : 'Inactive'}</td>
          <td><button disabled={Boolean(u.deletedAt)||busy===u.id} className="mr-2 text-xs text-profit" onClick={() => void run(u.id,()=>api.put('/admin/users/'+u.id+'/trading',{enabled:true}))}>Enable</button><button disabled={Boolean(u.deletedAt)||busy===u.id} className="text-xs text-loss" onClick={() => void run(u.id,()=>api.put('/admin/users/'+u.id+'/trading',{enabled:false}))}>Pause</button></td>
          <td className="space-x-2">{!u.deletedAt && (u.isSuspended ? <button disabled={busy===u.id} className="text-xs text-profit" onClick={() => void resume(u)}>Resume</button> : <button disabled={busy===u.id} className="text-xs text-amber-300" onClick={() => void suspend(u)}>Suspend</button>)} {!u.deletedAt && <button disabled={busy===u.id} className="text-xs text-loss" onClick={() => void remove(u)}>Delete</button>}</td>
        </tr>)}</tbody>
      </table>
    </section>

    {selected && <section className="card">
      <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-white">User detail</h3><p className="text-xs text-slate-500">{selected.email ?? selected.telegramId ?? selected.id} · {status(selected)}</p></div><button className="text-xs text-slate-400" onClick={() => setSelected(null)}>Close</button></div>
      {selected.suspensionReason && <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">{selected.suspensionReason}</div>}
      <div className="mt-4 overflow-x-auto"><table className="table-base min-w-[760px]"><thead><tr><th>Wallet</th><th>Status</th><th>Balance cache</th><th>Positions</th><th>Trades</th><th>Ledger</th></tr></thead><tbody>{selected.wallets.map((w)=><tr key={w.id}><td>{w.label}<div className="text-[11px] text-slate-500">{short(w.publicKey)}</div></td><td>{w.isActive?'Active':'Disabled'}</td><td>{w.lastKnownBalanceLamports==null?'—':(Number(w.lastKnownBalanceLamports)/1e9).toFixed(6)+' SOL'}</td><td>{w._count.positions}</td><td>{w._count.trades}</td><td>{w._count.ledgerEntries}</td></tr>)}</tbody></table></div>
    </section>}
  </div>;
}
