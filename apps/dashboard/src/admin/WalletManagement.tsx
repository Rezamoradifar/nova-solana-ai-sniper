import { useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';

type Page<T> = { total: number; rows: T[] };
type WalletRow = {
  id: string;
  label: string;
  publicKey: string;
  isActive: boolean;
  lastKnownBalanceLamports: string | null;
  balanceUpdatedAt: string | null;
  createdAt: string;
  user: { id: string; email: string | null; telegramId: string | null; isSuspended: boolean; deletedAt: string | null };
  _count: { positions: number; trades: number; ledgerEntries: number };
};
const short=(v:string)=>v.length>16?v.slice(0,8)+'…'+v.slice(-5):v;
const errorText=(e:unknown)=>e instanceof ApiError?e.message:e instanceof Error?e.message:'Request failed';

export function WalletManagement() {
  const [refresh,setRefresh]=useState(0);
  const q=usePolling(()=>api.get<Page<WalletRow>>('/admin/wallets?limit=100'),15_000,refresh);
  const [busy,setBusy]=useState<string|null>(null);

  async function act(id:string, fn:()=>Promise<unknown>) {
    setBusy(id);
    try { await fn(); setRefresh(v=>v+1); }
    catch(e){ window.alert(errorText(e)); }
    finally{ setBusy(null); }
  }

  return <section className="card overflow-x-auto">
    <div className="mb-4"><h2 className="text-lg font-semibold text-white">Wallet Management · {q.data?.total ?? 0}</h2><p className="text-xs text-slate-500">Private keys are never exposed. A wallet with an open position cannot be disabled.</p></div>
    <table className="table-base min-w-[1050px]"><thead><tr><th>Wallet</th><th>User</th><th>Status</th><th>Cached balance</th><th>Positions</th><th>Trades</th><th>Ledger</th><th>Updated</th><th>Actions</th></tr></thead>
    <tbody>{(q.data?.rows??[]).map(w=><tr key={w.id}>
      <td>{w.label}<div className="text-[11px] text-slate-500"><a target="_blank" rel="noreferrer" className="text-violet-300" href={'https://solscan.io/account/'+w.publicKey}>{short(w.publicKey)}</a></div></td>
      <td>{w.user.email ?? w.user.telegramId ?? short(w.user.id)}{w.user.isSuspended && <div className="text-[11px] text-amber-300">Suspended user</div>}</td>
      <td className={w.isActive?'text-profit':'text-slate-500'}>{w.isActive?'Active':'Disabled'}</td>
      <td>{w.lastKnownBalanceLamports==null?'—':(Number(w.lastKnownBalanceLamports)/1e9).toFixed(6)+' SOL'}</td>
      <td>{w._count.positions}</td><td>{w._count.trades}</td><td>{w._count.ledgerEntries}</td>
      <td>{w.balanceUpdatedAt?new Date(w.balanceUpdatedAt).toLocaleString():'Never'}</td>
      <td className="space-x-2"><button disabled={busy===w.id||!w.isActive} className="text-xs text-violet-300" onClick={()=>void act(w.id,()=>api.post('/admin/wallets/'+w.id+'/refresh-balance'))}>Refresh</button><button disabled={busy===w.id} className={w.isActive?'text-xs text-loss':'text-xs text-profit'} onClick={()=>void act(w.id,()=>api.put('/admin/wallets/'+w.id+'/status',{enabled:!w.isActive}))}>{w.isActive?'Disable':'Enable'}</button></td>
    </tr>)}</tbody></table>
  </section>;
}
