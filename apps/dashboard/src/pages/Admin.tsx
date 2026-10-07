
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.js';
import { usePolling } from '../lib/usePolling.js';

type Tab = 'control' | 'users' | 'trades' | 'positions' | 'money' | 'audit';
type Page<T> = { total: number; rows: T[] };

type Control = {
  runtime: { tradingMode: 'LIVE' | 'PAPER' | null; backgroundWorkersReady: boolean; killSwitch: boolean; autoBuyPaused: boolean };
  safety: { maxTradeSol: number; maxDailyLossUsd: number; maxOpenPositions: number; minWalletReserveSol: number; maxStopLossPercent: number };
  features: { key: string; label: string; enabled: boolean; restartRequired: boolean }[];
  integrations: { key: string; label: string; configured: boolean }[];
  counters: { users: number; activeWallets: number; activeSnipes: number; autoBuySnipes: number; openPositions: number; liveTrades24h: number; paperTrades24h: number; withdrawalsPending: number; payoutsPending: number };
  profit: { netProfitUsd24h: number; platformFeeUsd24h: number; referralRewardsUsd24h: number };
  arbitrage: { enabled: boolean; scans?: number; opportunities?: number; bestNetSol?: number };
};

type Overview = { settings: { performanceFeeBps: number; referralProgramEnabled: boolean } };

const money = (n: number) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const short = (v: string | null | undefined) => !v ? '—' : v.length > 16 ? v.slice(0, 8) + '…' + v.slice(-5) : v;
const err = (e: unknown) => e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Request failed';

function Stat(props: { label: string; value: string; sub?: string; tone?: string }) {
  return <div className="card"><div className="label">{props.label}</div><div className={'text-xl font-semibold ' + (props.tone ?? 'text-white')}>{props.value}</div>{props.sub && <div className="mt-1 text-xs text-slate-500">{props.sub}</div>}</div>;
}
function Dot(props: { on: boolean }) { return <span className={'h-2.5 w-2.5 rounded-full ' + (props.on ? 'bg-profit' : 'bg-slate-600')} />; }

const PRESETS = [
  ['Defensive', { scope: 'active', minAiScore: 75, minLiquidityUsd: 10000, takeProfitPercent: 35, stopLossPercent: 10, trailingStopPercent: 8, entryFilterEnabled: true }],
  ['Balanced', { scope: 'active', minAiScore: 65, minLiquidityUsd: 5000, takeProfitPercent: 50, stopLossPercent: 15, trailingStopPercent: 12 }],
  ['Momentum', { scope: 'active', minAiScore: 70, minLiquidityUsd: 3000, takeProfitPercent: 80, stopLossPercent: 20, trailingStopPercent: 15, useOpportunityScoreGate: true }],
] as const;

export function Admin() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('control');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const control = usePolling(() => api.get<Control>('/admin/control-center'), 10000, refresh);
  const overview = usePolling(() => api.get<Overview>('/admin/overview'), 15000, refresh);
  const [fee, setFee] = useState('');

  useEffect(() => {
    if (overview.data && fee === '') setFee(String(overview.data.settings.performanceFeeBps / 100));
  }, [overview.data, fee]);

  async function put(path: string, body: unknown, ok: string) {
    setBusy(true); setFailure(null); setMessage(null);
    try { await api.put(path, body); setMessage(ok); setRefresh((v) => v + 1); }
    catch (e) { setFailure(err(e)); }
    finally { setBusy(false); }
  }

  if (!(user?.isAdmin || user?.role === 'ADMIN')) return <div className="card text-slate-300">Admin access required.</div>;
  const c = control.data;
  const tabs: Array<[Tab, string]> = [['control','Control'],['users','Users'],['trades','Trades'],['positions','Positions'],['money','Money'],['audit','Audit']];

  return <div className="space-y-6">
    <div><div className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">GSP Operations</div><h1 className="mt-1 text-2xl font-semibold text-white">Admin Control Center</h1><p className="mt-1 text-sm text-slate-400">Trading, risk, users, money flows and infrastructure. Secrets are never exposed.</p></div>
    <div className="flex gap-2 overflow-x-auto">{tabs.map(([k,l]) => <button key={k} onClick={() => setTab(k)} className={'rounded-lg px-4 py-2 text-sm ' + (tab === k ? 'bg-accent text-white' : 'border border-surface-border bg-surface-raised text-slate-400')}>{l}</button>)}</div>
    {message && <div className="rounded-lg border border-profit/30 bg-profit/10 p-3 text-sm text-green-300">{message}</div>}
    {failure && <div className="rounded-lg border border-loss/30 bg-loss/10 p-3 text-sm text-red-300">{failure}</div>}

    {tab === 'control' && (!c ? <div className="card text-slate-400">Loading…</div> : <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Mode" value={c.runtime.tradingMode ?? 'OFFLINE'} tone={c.runtime.tradingMode === 'LIVE' ? 'text-loss' : 'text-violet-300'} />
        <Stat label="Users" value={String(c.counters.users)} sub={String(c.counters.activeWallets) + ' wallets'} />
        <Stat label="Open positions" value={String(c.counters.openPositions)} />
        <Stat label="Net profit / 24h" value={money(c.profit.netProfitUsd24h)} tone={c.profit.netProfitUsd24h >= 0 ? 'text-profit' : 'text-loss'} />
        <Stat label="Live trades / 24h" value={String(c.counters.liveTrades24h)} sub={String(c.counters.paperTrades24h) + ' paper'} />
        <Stat label="Auto-buy configs" value={String(c.counters.autoBuySnipes)} sub={String(c.counters.activeSnipes) + ' active snipes'} />
        <Stat label="Pending payouts" value={String(c.counters.payoutsPending)} />
        <Stat label="Withdrawals" value={String(c.counters.withdrawalsPending)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="card"><h2 className="font-semibold text-white">Immediate controls</h2><div className="mt-4 space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-surface-border p-3"><div><div className="text-sm text-slate-200">Kill switch</div><div className="text-xs text-slate-500">Blocks every new trade immediately.</div></div><button disabled={busy} className={c.runtime.killSwitch ? 'btn-primary' : 'rounded-lg bg-loss px-4 py-2 text-sm font-semibold text-white'} onClick={() => void put('/admin/trading/kill-switch', { enabled: !c.runtime.killSwitch }, 'Kill switch updated.')}>{c.runtime.killSwitch ? 'Disable' : 'Activate'}</button></div>
          <div className="flex items-center justify-between rounded-lg border border-surface-border p-3"><div><div className="text-sm text-slate-200">Auto-buy</div><div className="text-xs text-slate-500">{c.runtime.autoBuyPaused ? 'Paused' : 'Running'}</div></div><button disabled={busy} className="btn-secondary" onClick={() => void put('/admin/trading/auto-buy', { enabled: c.runtime.autoBuyPaused }, 'Auto-buy updated.')}>{c.runtime.autoBuyPaused ? 'Resume' : 'Pause'}</button></div>
        </div></section>
        <section className="card"><h2 className="font-semibold text-white">Platform economics</h2><div className="mt-4 flex items-end gap-3"><div className="flex-1"><label className="label">Performance fee %</label><input className="input-field" type="number" min="0" max="100" step="0.1" value={fee} onChange={(e) => setFee(e.target.value)} /></div><button disabled={busy} className="btn-primary" onClick={() => void put('/admin/settings/fee', { percent: Number(fee) }, 'Fee updated.')}>Save</button></div>{overview.data && <div className="mt-4 flex items-center justify-between rounded-lg border border-surface-border p-3"><span className="text-sm text-slate-300">Referral program</span><button className="btn-secondary" onClick={() => void put('/admin/settings/referral-program', { enabled: !overview.data!.settings.referralProgramEnabled }, 'Referral setting updated.')}>{overview.data.settings.referralProgramEnabled ? 'Disable' : 'Enable'}</button></div>}</section>
      </div>

      <section className="card"><h2 className="font-semibold text-white">Global strategy presets</h2><p className="mt-1 text-xs text-slate-500">Applies to active Snipe Configs. These are not profit guarantees.</p><div className="mt-4 grid gap-3 md:grid-cols-3">{PRESETS.map(([name, body]) => <button key={name} className="rounded-xl border border-surface-border bg-surface p-4 text-left hover:border-accent/50" onClick={() => { if (window.confirm('Apply ' + name + ' to all active configs?')) void put('/admin/snipes/bulk', body, name + ' preset applied.'); }}><div className="font-semibold text-white">{name}</div><div className="mt-2 text-xs text-slate-500">Click to apply with the 20% hard loss ceiling preserved.</div></button>)}</div></section>

      <div className="grid gap-4 xl:grid-cols-3">
        <section className="card xl:col-span-2"><h2 className="font-semibold text-white">Feature gates</h2><div className="mt-4 grid gap-2 sm:grid-cols-2">{c.features.map((f) => <div key={f.key} className="flex items-center gap-3 rounded-lg border border-surface-border p-3"><Dot on={f.enabled} /><div><div className="text-sm text-slate-200">{f.label}</div><div className="text-[11px] text-slate-500">{f.enabled ? 'Enabled' : 'Disabled'}{f.restartRequired ? ' · restart required to change' : ''}</div></div></div>)}</div></section>
        <section className="card"><h2 className="font-semibold text-white">Safety</h2><div className="mt-4 space-y-2 text-sm"><div className="flex justify-between"><span className="text-slate-500">Max trade</span><span>{c.safety.maxTradeSol} SOL</span></div><div className="flex justify-between"><span className="text-slate-500">Daily loss</span><span>{money(c.safety.maxDailyLossUsd)}</span></div><div className="flex justify-between"><span className="text-slate-500">Max positions</span><span>{c.safety.maxOpenPositions}</span></div><div className="flex justify-between"><span className="text-slate-500">SL ceiling</span><span>{c.safety.maxStopLossPercent}%</span></div></div></section>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="card"><h2 className="font-semibold text-white">Integrations</h2><div className="mt-4 grid grid-cols-2 gap-2">{c.integrations.map((i) => <div key={i.key} className="flex items-center gap-2 rounded-lg border border-surface-border p-2.5"><Dot on={i.configured} /><span className="text-sm text-slate-300">{i.label}</span></div>)}</div></section>
        <section className="card"><h2 className="font-semibold text-white">Arbitrage radar</h2><p className="mt-1 text-xs text-slate-500">Paper/theoretical only — no execution.</p><div className="mt-4 grid grid-cols-2 gap-3"><Stat label="Status" value={c.arbitrage.enabled ? 'ON' : 'OFF'} /><Stat label="Scans" value={String(c.arbitrage.scans ?? 0)} /><Stat label="Opportunities" value={String(c.arbitrage.opportunities ?? 0)} /><Stat label="Best net" value={c.arbitrage.bestNetSol == null ? '—' : c.arbitrage.bestNetSol.toFixed(5) + ' SOL'} tone="text-profit" /></div></section>
      </div>
    </div>)}

    {tab === 'users' && <Users />}
    {tab === 'trades' && <Trades />}
    {tab === 'positions' && <Positions />}
    {tab === 'money' && <Money />}
    {tab === 'audit' && <Audit />}
  </div>;
}

type UserRow = { id: string; email: string | null; telegramId: string | null; role: string; planKey: string; telegramActive: boolean; createdAt: string; _count: { wallets: number; snipeConfigs: number; copyConfigs: number } };
function Users() {
  const [r, setR] = useState(0); const q = usePolling(() => api.get<Page<UserRow>>('/admin/users?limit=100'), 20000, r);
  const setTrading = async (id: string, enabled: boolean) => { await api.put('/admin/users/' + id + '/trading', { enabled }); setR((v) => v + 1); };
  return <section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">Users · {q.data?.total ?? 0}</h2><table className="table-base min-w-[850px]"><thead><tr><th>User</th><th>Plan</th><th>Wallets</th><th>Snipes</th><th>Copy</th><th>Telegram</th><th>Trading</th></tr></thead><tbody>{(q.data?.rows ?? []).map((x) => <tr key={x.id}><td>{x.email ?? x.telegramId ?? short(x.id)}</td><td>{x.planKey}</td><td>{x._count.wallets}</td><td>{x._count.snipeConfigs}</td><td>{x._count.copyConfigs}</td><td>{x.telegramActive ? 'Active' : 'Inactive'}</td><td><button className="mr-2 text-xs text-profit" onClick={() => void setTrading(x.id, true)}>Resume</button><button className="text-xs text-loss" onClick={() => void setTrading(x.id, false)}>Pause</button></td></tr>)}</tbody></table></section>;
}
type TradeRow = { id: string; side: string; status: string; amountSol: number; priceUsd: number | null; txSignature: string | null; isPaperTrade: boolean; createdAt: string; token: { symbol: string | null; mint: string }; wallet: { user: { id: string; email: string | null; telegramId: string | null } } };
function Trades() {
  const q = usePolling(() => api.get<Page<TradeRow>>('/admin/trades?limit=100'), 15000);
  return <section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">All trades</h2><table className="table-base min-w-[950px]"><thead><tr><th>Mode</th><th>Side</th><th>Token</th><th>User</th><th>Amount</th><th>Price</th><th>Status</th><th>TX</th></tr></thead><tbody>{(q.data?.rows ?? []).map((x) => <tr key={x.id}><td>{x.isPaperTrade ? 'PAPER' : 'LIVE'}</td><td>{x.side}</td><td>{x.token.symbol ?? short(x.token.mint)}</td><td>{x.wallet.user.email ?? x.wallet.user.telegramId ?? short(x.wallet.user.id)}</td><td>{x.amountSol.toFixed(4)} SOL</td><td>{x.priceUsd ? usd(x.priceUsd) : '—'}</td><td>{x.status}</td><td>{x.txSignature ? <a className="text-violet-300" target="_blank" rel="noreferrer" href={'https://solscan.io/tx/' + x.txSignature}>{short(x.txSignature)}</a> : '—'}</td></tr>)}</tbody></table></section>;
}
type PositionRow = { id: string; status: string; amountSolInvested: number; realizedPnlUsd: number | null; stopLossPercent: number | null; takeProfitPercent: number | null; isPaperTrade: boolean; token: { symbol: string | null; mint: string }; wallet: { user: { id: string; email: string | null; telegramId: string | null } } };
function Positions() {
  const [r, setR] = useState(0); const q = usePolling(() => api.get<Page<PositionRow>>('/admin/positions?limit=100'), 15000, r);
  const close = async (x: PositionRow) => { if (!window.confirm('Force-close this position? LIVE positions can move real funds.')) return; try { await api.post('/admin/positions/' + x.id + '/close'); setR((v) => v + 1); } catch (e) { window.alert(err(e)); } };
  return <section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">All positions</h2><table className="table-base min-w-[900px]"><thead><tr><th>Mode</th><th>Token</th><th>User</th><th>Invested</th><th>TP / SL</th><th>PnL</th><th>Status</th><th /></tr></thead><tbody>{(q.data?.rows ?? []).map((x) => <tr key={x.id}><td>{x.isPaperTrade ? 'PAPER' : 'LIVE'}</td><td>{x.token.symbol ?? short(x.token.mint)}</td><td>{x.wallet.user.email ?? x.wallet.user.telegramId ?? short(x.wallet.user.id)}</td><td>{x.amountSolInvested.toFixed(4)} SOL</td><td>{x.takeProfitPercent ?? '—'}% / {x.stopLossPercent ?? '—'}%</td><td>{x.realizedPnlUsd == null ? '—' : usd(x.realizedPnlUsd)}</td><td>{x.status}</td><td>{x.status === 'OPEN' && <button className="text-xs text-loss" onClick={() => void close(x)}>Force close</button>}</td></tr>)}</tbody></table></section>;
}
type Withdrawal = { id: string; userId: string; amountUsd: number; destinationAddress: string; status: string; riskScore: number; requestedAt: string };
type Payout = { id: string; positionId: string; status: string; totalLamports: string; txSignature: string | null; failureReason: string | null; createdAt: string };
function Money() {
  const w = usePolling(() => api.get<Page<Withdrawal>>('/admin/withdrawals?limit=100'), 20000); const p = usePolling(() => api.get<Page<Payout>>('/admin/payouts?limit=100'), 20000);
  return <div className="space-y-5"><section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">Withdrawal queue</h2><table className="table-base min-w-[700px]"><thead><tr><th>Status</th><th>User</th><th>Amount</th><th>Destination</th><th>Risk</th></tr></thead><tbody>{(w.data?.rows ?? []).map((x) => <tr key={x.id}><td>{x.status}</td><td>{short(x.userId)}</td><td>{usd(x.amountUsd)}</td><td>{short(x.destinationAddress)}</td><td>{x.riskScore.toFixed(0)}</td></tr>)}</tbody></table></section><section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">Payout attempts</h2><table className="table-base min-w-[700px]"><thead><tr><th>Status</th><th>Position</th><th>Total</th><th>TX / error</th></tr></thead><tbody>{(p.data?.rows ?? []).map((x) => <tr key={x.id}><td>{x.status}</td><td>{short(x.positionId)}</td><td>{(Number(x.totalLamports) / 1e9).toFixed(5)} SOL</td><td>{x.txSignature ? short(x.txSignature) : x.failureReason ?? '—'}</td></tr>)}</tbody></table></section></div>;
}
type AuditRow = { id: string; action: string; status: string; ip: string | null; createdAt: string; metadata: unknown; user: { email: string | null; telegramId: string | null } | null };
function Audit() {
  const q = usePolling(() => api.get<Page<AuditRow>>('/admin/audit?limit=150'), 20000);
  return <section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">Audit log</h2><table className="table-base min-w-[800px]"><thead><tr><th>Action</th><th>Status</th><th>Actor</th><th>IP</th><th>Time</th></tr></thead><tbody>{(q.data?.rows ?? []).map((x) => <tr key={x.id}><td>{x.action}</td><td>{x.status}</td><td>{x.user?.email ?? x.user?.telegramId ?? 'system'}</td><td>{x.ip ?? '—'}</td><td>{new Date(x.createdAt).toLocaleString()}</td></tr>)}</tbody></table></section>;
}
