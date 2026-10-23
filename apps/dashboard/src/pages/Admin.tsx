
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.js';
import { usePolling } from '../lib/usePolling.js';
import { UserManagement } from '../admin/UserManagement.js';
import { WalletManagement } from '../admin/WalletManagement.js';
import { CopyTradingManagement } from '../admin/CopyTradingManagement.js';
import { BlacklistManagement } from '../admin/BlacklistManagement.js';
import { BroadcastManagement } from '../admin/BroadcastManagement.js';
import { WithdrawalManagement } from '../admin/WithdrawalManagement.js';
import { useLanguage } from '../lib/LanguageContext.js';

type Tab =
  | 'control'
  | 'users'
  | 'wallets'
  | 'trades'
  | 'positions'
  | 'copy'
  | 'blacklist'
  | 'broadcast'
  | 'plans'
  | 'money'
  | 'audit';
type Page<T> = { total: number; rows: T[] };

type Control = {
  runtime: { tradingMode: 'LIVE' | 'PAPER' | null; backgroundWorkersReady: boolean; killSwitch: boolean; autoBuyPaused: boolean; scanner: { state?: string; activeProviderLabel?: string } | null };
  safety: { maxTradeSol: number; maxDailyLossUsd: number; maxOpenPositions: number; minWalletReserveSol: number; maxStopLossPercent: number };
  features: { key: string; label: string; enabled: boolean; restartRequired: boolean }[];
  integrations: { key: string; label: string; configured: boolean }[];
  counters: { users: number; activeWallets: number; activeSnipes: number; autoBuySnipes: number; activeCopyConfigs: number; openPositions: number; liveTrades24h: number; paperTrades24h: number; withdrawalsPending: number; payoutsPending: number };
  profit: { netProfitUsd24h: number; platformFeeUsd24h: number; referralRewardsUsd24h: number };
  arbitrage: { enabled: boolean; scans?: number; opportunities?: number; bestNetSol?: number };
};

type Overview = { settings: { treasuryWalletAddress: string | null; envTreasuryWalletAddress: string; performanceFeeBps: number; referralProgramEnabled: boolean; referralLevels: Array<{ level:number; percentBps:number; enabled:boolean }> } };
type FeatureSetting = {
  key: string;
  label: string;
  effectiveEnabled: boolean;
  desiredEnabled: boolean;
  restartRequired: boolean;
  pendingRestart: boolean;
};

const money = (n: number) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const short = (v: string | null | undefined) => !v ? '—' : v.length > 16 ? v.slice(0, 8) + '…' + v.slice(-5) : v;
const err = (e: unknown) => e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Request failed';

function Stat(props: { label: string; value: string; sub?: string; tone?: string }) {
  const { t: localize } = useLanguage();
  return <div className="card"><div className="label">{localize(props.label)}</div><div className={'text-xl font-semibold ' + (props.tone ?? 'text-white')}>{props.value}</div>{props.sub && <div className="mt-1 text-xs text-slate-500">{props.sub}</div>}</div>;
}
function Dot(props: { on: boolean }) { return <span className={'h-2.5 w-2.5 rounded-full ' + (props.on ? 'bg-profit' : 'bg-slate-600')} />; }

const PRESETS = [
  ['Defensive', { scope: 'active', minAiScore: 75, minLiquidityUsd: 10000, takeProfitPercent: 35, stopLossPercent: 10, trailingStopPercent: 8, entryFilterEnabled: true }],
  ['Balanced', { scope: 'active', minAiScore: 65, minLiquidityUsd: 5000, takeProfitPercent: 50, stopLossPercent: 15, trailingStopPercent: 12 }],
  ['Momentum', { scope: 'active', minAiScore: 70, minLiquidityUsd: 3000, takeProfitPercent: 80, stopLossPercent: 20, trailingStopPercent: 15, useOpportunityScoreGate: true }],
] as const;

export function Admin() {
  const { t: localize } = useLanguage();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('control');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const control = usePolling(() => api.get<Control>('/admin/control-center'), 10000, refresh);
  const overview = usePolling(() => api.get<Overview>('/admin/overview'), 15000, refresh);
  const featureSettings = usePolling(() => api.get<FeatureSetting[]>('/admin/features'), 15000, refresh);
  const [fee, setFee] = useState('');
  const [treasury, setTreasury] = useState('');
  const [refPercents, setRefPercents] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!overview.data) return;
    if (fee === '') setFee(String(overview.data.settings.performanceFeeBps / 100));
    if (treasury === '') {
      setTreasury(
        overview.data.settings.treasuryWalletAddress ??
          overview.data.settings.envTreasuryWalletAddress,
      );
    }
    if (Object.keys(refPercents).length === 0) {
      setRefPercents(
        Object.fromEntries(
          overview.data.settings.referralLevels.map((level) => [
            level.level,
            String(level.percentBps / 100),
          ]),
        ),
      );
    }
  }, [overview.data, fee, treasury, refPercents]);

  async function put(path: string, body: unknown, ok: string) {
    setBusy(true); setFailure(null); setMessage(null);
    try { await api.put(path, body); setMessage(ok); setRefresh((v) => v + 1); }
    catch (e) { setFailure(err(e)); }
    finally { setBusy(false); }
  }

  if (!(user?.isAdmin || user?.role === 'ADMIN')) return <div className="card text-slate-300">{localize("Admin access required.")}</div>;
  const c = control.data;
  const tabs: Array<[Tab, string]> = [
    ['control', 'Control'],
    ['users', 'Users'],
    ['wallets', 'Wallets'],
    ['trades', 'Trades'],
    ['positions', 'Positions'],
    ['copy', 'Copy Trading'],
    ['blacklist', 'Blacklist'],
    ['broadcast', 'Broadcast'],
    ['plans', 'Plans & Revenue'],
    ['money', 'Withdrawals & Payouts'],
    ['audit', 'Audit'],
  ];

  return <div className="space-y-6">
    <div><div className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">{localize("GSP TRADING Operations")}</div><h1 className="mt-1 text-2xl font-semibold text-white">{localize("Admin Control Center")}</h1><p className="mt-1 text-sm text-slate-400">{localize("Trading, risk, users, money flows and infrastructure. Secrets are never exposed.")}</p></div>
    <div className="flex gap-2 overflow-x-auto">{tabs.map(([k,l]) => <button key={k} onClick={() => setTab(k)} className={'rounded-lg px-4 py-2 text-sm ' + (tab === k ? 'bg-accent text-white' : 'border border-surface-border bg-surface-raised text-slate-400')}>{l}</button>)}</div>
    {message && <div className="rounded-lg border border-profit/30 bg-profit/10 p-3 text-sm text-green-300">{localize(message ?? "")}</div>}
    {failure && <div className="rounded-lg border border-loss/30 bg-loss/10 p-3 text-sm text-red-300">{failure}</div>}

    {tab === 'control' && (!c ? <div className="card text-slate-400">{localize("Loading…")}</div> : <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={localize("Mode")} value={c.runtime.tradingMode ?? 'OFFLINE'} tone={c.runtime.tradingMode === 'LIVE' ? 'text-loss' : 'text-violet-300'} sub={c.runtime.backgroundWorkersReady ? 'workers ready' : 'workers not ready'} />
        <Stat label={localize("Scanner")} value={c.runtime.scanner?.state ?? 'UNKNOWN'} sub={c.runtime.scanner?.activeProviderLabel ?? 'provider unresolved'} /><Stat label={localize("Users")} value={String(c.counters.users)} sub={String(c.counters.activeWallets) + ' wallets'} />
        <Stat label={localize("Open positions")} value={String(c.counters.openPositions)} />
        <Stat label={localize("Net profit / 24h")} value={money(c.profit.netProfitUsd24h)} tone={c.profit.netProfitUsd24h >= 0 ? 'text-profit' : 'text-loss'} />
        <Stat label={localize("Live trades / 24h")} value={String(c.counters.liveTrades24h)} sub={String(c.counters.paperTrades24h) + ' paper'} />
        <Stat label={localize("Auto-buy configs")} value={String(c.counters.autoBuySnipes)} sub={String(c.counters.activeSnipes) + ' active snipes'} /><Stat label={localize("Copy configs")} value={String(c.counters.activeCopyConfigs)} sub="config records; live signal wiring not claimed" />
        <Stat label={localize("Pending payouts")} value={String(c.counters.payoutsPending)} />
        <Stat label={localize("Withdrawals")} value={String(c.counters.withdrawalsPending)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="card"><h2 className="font-semibold text-white">{localize("Immediate controls")}</h2><div className="mt-4 space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-surface-border p-3"><div><div className="text-sm text-slate-200">{localize("Kill switch")}</div><div className="text-xs text-slate-500">{localize("Blocks every new trade immediately.")}</div></div><button disabled={busy} className={c.runtime.killSwitch ? 'btn-primary' : 'rounded-lg bg-loss px-4 py-2 text-sm font-semibold text-white'} onClick={() => void put('/admin/trading/kill-switch', { enabled: !c.runtime.killSwitch }, 'Kill switch updated.')}>{c.runtime.killSwitch ? localize("Disable") : localize("Activate")}</button></div>
          <div className="flex items-center justify-between rounded-lg border border-surface-border p-3"><div><div className="text-sm text-slate-200">{localize("Auto-buy")}</div><div className="text-xs text-slate-500">{c.runtime.autoBuyPaused ? localize("Paused") : localize("Running")}</div></div><button disabled={busy} className="btn-secondary" onClick={() => void put('/admin/trading/auto-buy', { enabled: c.runtime.autoBuyPaused }, 'Auto-buy updated.')}>{c.runtime.autoBuyPaused ? localize("Resume") : localize("Pause")}</button></div>
        </div></section>
        <section className="card"><h2 className="font-semibold text-white">{localize("Platform economics")}</h2><div className="mt-4 flex items-end gap-3"><div className="flex-1"><label className="label">{localize("Performance fee %")}</label><input className="input-field" type="number" min="0" max="100" step="0.1" value={fee} onChange={(e) => setFee(e.target.value)} /></div><button disabled={busy} className="btn-primary" onClick={() => void put('/admin/settings/fee', { percent: Number(fee) }, 'Fee updated.')}>{localize("Save")}</button></div><div className="mt-4"><label className="label">{localize("Treasury wallet")}</label><div className="flex gap-2"><input className="input-field font-mono text-xs" value={treasury} onChange={(e)=>setTreasury(e.target.value)} /><button disabled={busy || !treasury.trim()} className="btn-secondary" onClick={() => void put('/admin/settings/treasury', { address: treasury.trim() }, 'Treasury wallet updated.')}>{localize("Save")}</button></div></div>{overview.data && <><div className="mt-4 flex items-center justify-between rounded-lg border border-surface-border p-3"><span className="text-sm text-slate-300">{localize("Referral program")}</span><button className="btn-secondary" onClick={() => void put('/admin/settings/referral-program', { enabled: !overview.data!.settings.referralProgramEnabled }, 'Referral setting updated.')}>{overview.data.settings.referralProgramEnabled ? localize("Disable") : localize("Enable")}</button></div><div className="mt-3 space-y-2">{overview.data.settings.referralLevels.map((level)=><div key={level.level} className="flex items-center gap-2 rounded-lg border border-surface-border p-2"><span className="w-16 text-xs text-slate-400">{localize("Level") + " "}{level.level}</span><input className="input-field flex-1" type="number" min="0" max="100" step="0.1" value={refPercents[level.level] ?? ''} onChange={(e)=>setRefPercents({...refPercents,[level.level]:e.target.value})}/><span className="text-xs text-slate-500">%</span><button disabled={busy} className="text-xs text-violet-300" onClick={() => void put('/admin/settings/referral/' + level.level, { percent: Number(refPercents[level.level] ?? 0) }, 'Referral level updated.')}>{localize("Save")}</button></div>)}</div></>}</section>
      </div>

      <section className="card"><h2 className="font-semibold text-white">{localize("Global strategy presets")}</h2><p className="mt-1 text-xs text-slate-500">{localize("Applies to active Snipe Configs. These are not profit guarantees.")}</p><div className="mt-4 grid gap-3 md:grid-cols-3">{PRESETS.map(([name, body]) => <button key={name} className="rounded-xl border border-surface-border bg-surface p-4 text-left hover:border-accent/50" onClick={() => { if (window.confirm('Apply ' + name + ' to all active configs?')) void put('/admin/snipes/bulk', body, name + ' preset applied.'); }}><div className="font-semibold text-white">{name}</div><div className="mt-2 text-xs text-slate-500">{localize("Click to apply with the 20% hard loss ceiling preserved.")}</div></button>)}</div></section>

      <div className="grid gap-4 xl:grid-cols-3">
        <section className="card xl:col-span-2"><h2 className="font-semibold text-white">{localize("Feature gates")}</h2><p className="mt-1 text-xs text-slate-500">{localize("Desired state is persisted. Startup-sensitive features apply after service restart.")}</p><div className="mt-4 grid gap-2 sm:grid-cols-2">{(featureSettings.data ?? c.features.map((f) => ({ key:f.key, label:f.label, effectiveEnabled:f.enabled, desiredEnabled:f.enabled, restartRequired:f.restartRequired, pendingRestart:false }))).map((f) => <div key={f.key} className="flex items-center gap-3 rounded-lg border border-surface-border p-3"><Dot on={f.effectiveEnabled} /><div className="min-w-0 flex-1"><div className="text-sm text-slate-200">{localize(f.label)}</div><div className="text-[11px] text-slate-500">{localize("Running:") + " "}{f.effectiveEnabled ? localize("ON") : localize("OFF")}{" " + localize("· Desired:") + " "}{f.desiredEnabled ? localize("ON") : localize("OFF")}{f.pendingRestart ? " " + localize("· pending restart") : ''}</div></div><button disabled={busy} className="rounded-md border border-surface-border px-2 py-1 text-xs text-violet-300 hover:border-accent/60" onClick={() => void put('/admin/features/' + f.key, { enabled: !f.desiredEnabled }, 'Feature desired state saved; restart is required to apply it.')}>{f.desiredEnabled ? localize("Set OFF") : localize("Set ON")}</button></div>)}</div></section>
        <section className="card"><h2 className="font-semibold text-white">{localize("Safety")}</h2><div className="mt-4 space-y-2 text-sm"><div className="flex justify-between"><span className="text-slate-500">{localize("Max trade")}</span><span>{c.safety.maxTradeSol} SOL</span></div><div className="flex justify-between"><span className="text-slate-500">{localize("Daily loss")}</span><span>{money(c.safety.maxDailyLossUsd)}</span></div><div className="flex justify-between"><span className="text-slate-500">{localize("Max positions")}</span><span>{c.safety.maxOpenPositions}</span></div><div className="flex justify-between"><span className="text-slate-500">{localize("SL ceiling")}</span><span>{c.safety.maxStopLossPercent}%</span></div></div></section>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="card"><h2 className="font-semibold text-white">{localize("Integrations")}</h2><div className="mt-4 grid grid-cols-2 gap-2">{c.integrations.map((i) => <div key={i.key} className="flex items-center gap-2 rounded-lg border border-surface-border p-2.5"><Dot on={i.configured} /><span className="text-sm text-slate-300">{localize(i.label)}</span></div>)}</div></section>
        <section className="card"><h2 className="font-semibold text-white">{localize("Arbitrage radar")}</h2><p className="mt-1 text-xs text-slate-500">{localize("Paper/theoretical only — no execution.")}</p><div className="mt-4 grid grid-cols-2 gap-3"><Stat label={localize("Status")} value={c.arbitrage.enabled ? 'ON' : 'OFF'} /><Stat label={localize("Scans")} value={String(c.arbitrage.scans ?? 0)} /><Stat label={localize("Opportunities")} value={String(c.arbitrage.opportunities ?? 0)} /><Stat label={localize("Best net")} value={c.arbitrage.bestNetSol == null ? '—' : c.arbitrage.bestNetSol.toFixed(5) + ' SOL'} tone="text-profit" /></div></section>
      </div>
    </div>)}

    {tab === 'users' && <UserManagement />}
    {tab === 'wallets' && <WalletManagement />}
    {tab === 'trades' && <Trades />}
    {tab === 'positions' && <Positions />}
    {tab === 'copy' && <CopyTradingManagement />}
    {tab === 'blacklist' && <BlacklistManagement />}
    {tab === 'broadcast' && <BroadcastManagement />}
    {tab === 'plans' && <Plans />}
    {tab === 'money' && <WithdrawalManagement />}
    {tab === 'audit' && <Audit />}
  </div>;
}

type UserRow = { id: string; email: string | null; telegramId: string | null; role: string; planKey: string; telegramActive: boolean; createdAt: string; _count: { wallets: number; snipeConfigs: number; copyConfigs: number } };
function Users() {
  const { t: localize } = useLanguage();
  const [r, setR] = useState(0); const q = usePolling(() => api.get<Page<UserRow>>('/admin/users?limit=100'), 20000, r);
  const setTrading = async (id: string, enabled: boolean) => { await api.put('/admin/users/' + id + '/trading', { enabled }); setR((v) => v + 1); };
  return <section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">{localize("Users ·") + " "}{q.data?.total ?? 0}</h2><table className="table-base min-w-[850px]"><thead><tr><th>{localize("User")}</th><th>{localize("Plan")}</th><th>{localize("Wallets")}</th><th>{localize("Snipes")}</th><th>{localize("Copy")}</th><th>{localize("Telegram")}</th><th>{localize("Trading")}</th></tr></thead><tbody>{(q.data?.rows ?? []).map((x) => <tr key={x.id}><td>{x.email ?? x.telegramId ?? short(x.id)}</td><td>{x.planKey}</td><td>{x._count.wallets}</td><td>{x._count.snipeConfigs}</td><td>{x._count.copyConfigs}</td><td>{x.telegramActive ? localize("Active") : localize("Inactive")}</td><td><button className="mr-2 text-xs text-profit" onClick={() => void setTrading(x.id, true)}>{localize("Resume")}</button><button className="text-xs text-loss" onClick={() => void setTrading(x.id, false)}>{localize("Pause")}</button></td></tr>)}</tbody></table></section>;
}
type TradeRow = { id: string; side: string; status: string; amountSol: number; priceUsd: number | null; txSignature: string | null; isPaperTrade: boolean; createdAt: string; token: { symbol: string | null; mint: string }; wallet: { user: { id: string; email: string | null; telegramId: string | null } } };
function Trades() {
  const { t: localize } = useLanguage();
  const q = usePolling(() => api.get<Page<TradeRow>>('/admin/trades?limit=100'), 15000);
  return <section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">{localize("All trades")}</h2><table className="table-base min-w-[950px]"><thead><tr><th>{localize("Mode")}</th><th>{localize("Side")}</th><th>{localize("Token")}</th><th>{localize("User")}</th><th>{localize("Amount")}</th><th>{localize("Price")}</th><th>{localize("Status")}</th><th>TX</th></tr></thead><tbody>{(q.data?.rows ?? []).map((x) => <tr key={x.id}><td>{x.isPaperTrade ? 'PAPER' : 'LIVE'}</td><td>{x.side}</td><td>{x.token.symbol ?? short(x.token.mint)}</td><td>{x.wallet.user.email ?? x.wallet.user.telegramId ?? short(x.wallet.user.id)}</td><td>{x.amountSol.toFixed(4)} SOL</td><td>{x.priceUsd ? money(x.priceUsd) : '—'}</td><td>{x.status}</td><td>{x.txSignature ? <a className="text-violet-300" target="_blank" rel="noreferrer" href={'https://solscan.io/tx/' + x.txSignature}>{short(x.txSignature)}</a> : '—'}</td></tr>)}</tbody></table></section>;
}
type PositionRow = { id: string; status: string; amountSolInvested: number; realizedPnlUsd: number | null; stopLossPercent: number | null; takeProfitPercent: number | null; isPaperTrade: boolean; token: { symbol: string | null; mint: string }; wallet: { user: { id: string; email: string | null; telegramId: string | null } } };
function Positions() {
  const { t: localize } = useLanguage();
  const [r, setR] = useState(0); const q = usePolling(() => api.get<Page<PositionRow>>('/admin/positions?limit=100'), 15000, r);
  const close = async (x: PositionRow) => { if (!window.confirm('Force-close this position? LIVE positions can move real funds.')) return; try { await api.post('/admin/positions/' + x.id + '/close'); setR((v) => v + 1); } catch (e) { window.alert(err(e)); } };
  return <section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">{localize("All positions")}</h2><table className="table-base min-w-[900px]"><thead><tr><th>{localize("Mode")}</th><th>{localize("Token")}</th><th>{localize("User")}</th><th>{localize("Invested")}</th><th>{localize("TP / SL")}</th><th>{localize("PnL")}</th><th>{localize("Status")}</th><th /></tr></thead><tbody>{(q.data?.rows ?? []).map((x) => <tr key={x.id}><td>{x.isPaperTrade ? 'PAPER' : 'LIVE'}</td><td>{x.token.symbol ?? short(x.token.mint)}</td><td>{x.wallet.user.email ?? x.wallet.user.telegramId ?? short(x.wallet.user.id)}</td><td>{x.amountSolInvested.toFixed(4)} SOL</td><td>{x.takeProfitPercent ?? '—'}% / {x.stopLossPercent ?? '—'}%</td><td>{x.realizedPnlUsd == null ? '—' : money(x.realizedPnlUsd)}</td><td>{x.status}</td><td>{x.status === 'OPEN' && <button className="text-xs text-loss" onClick={() => void close(x)}>{localize("Force close")}</button>}</td></tr>)}</tbody></table></section>;
}


type CopyConfigRow = {
  id: string;
  userId: string;
  targetAddress: string;
  isActive: boolean;
  copyPercentSize: number;
  maxAmountSol: number | null;
  createdAt: string;
  user: { email: string | null; telegramId: string | null };
};
function CopyConfigs() {
  const { t: localize } = useLanguage();
  const [refresh, setRefresh] = useState(0);
  const q = usePolling(() => api.get<Page<CopyConfigRow>>('/admin/copy-trades?limit=100'), 20000, refresh);
  async function toggle(row: CopyConfigRow) {
    try {
      await api.put('/admin/copy-trades/' + row.id, { enabled: !row.isActive });
      setRefresh((v) => v + 1);
    } catch (e) {
      window.alert(err(e));
    }
  }
  return <div className="space-y-4">
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">{localize("Copy-trade configuration records are visible here. Live external-wallet signal execution is not claimed as active until its worker wiring is enabled and verified.")}</div>
    <section className="card overflow-x-auto">
      <h2 className="mb-4 text-lg font-semibold text-white">{localize("Copy configurations ·") + " "}{q.data?.total ?? 0}</h2>
      <table className="table-base min-w-[850px]">
        <thead><tr><th>{localize("User")}</th><th>{localize("Target wallet")}</th><th>{localize("Size")}</th><th>{localize("Max amount")}</th><th>{localize("Status")}</th><th>{localize("Created")}</th><th /></tr></thead>
        <tbody>{(q.data?.rows ?? []).map((row) => <tr key={row.id}>
          <td>{row.user.email ?? row.user.telegramId ?? short(row.userId)}</td>
          <td><a className="text-violet-300 hover:underline" target="_blank" rel="noreferrer" href={'https://solscan.io/account/' + row.targetAddress}>{short(row.targetAddress)}</a></td>
          <td>{row.copyPercentSize}%</td>
          <td>{row.maxAmountSol == null ? localize("Plan/default") : row.maxAmountSol + ' SOL'}</td>
          <td className={row.isActive ? 'text-profit' : 'text-slate-500'}>{row.isActive ? localize("Configured ON") : localize("Paused")}</td>
          <td>{new Date(row.createdAt).toLocaleDateString()}</td>
          <td><button className="text-xs text-violet-300" onClick={() => void toggle(row)}>{row.isActive ? localize("Pause") : localize("Resume config")}</button></td>
        </tr>)}</tbody>
      </table>
    </section>
  </div>;
}

type PlanRow = {
  key: string; name: string; priceSol: number; durationDays: number; feeBps: number | null;
  maxBuySol: number | null; maxOpenPositions: number | null; autoBuyEnabled: boolean; active: boolean;
  activeSubscribers: number; sales: number; revenueSol: number; sales30d: number; revenue30dSol: number;
};
type PlansResponse = {
  totals: { users: number; paidSubscribers: number; freeUsers: number; revenueSol: number; revenue30dSol: number; sales: number };
  plans: PlanRow[];
};

function Plans() {
  const { t: localize } = useLanguage();
  const [refresh, setRefresh] = useState(0);
  const q = usePolling(() => api.get<PlansResponse>('/admin/plans'), 30000, refresh);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ priceSol: '', feePercent: '', maxBuySol: '', maxOpenPositions: '', active: true, autoBuyEnabled: true });
  const [busy, setBusy] = useState(false);

  function edit(p: PlanRow) {
    setEditing(p.key);
    setDraft({
      priceSol: String(p.priceSol),
      feePercent: p.feeBps == null ? '' : String(p.feeBps / 100),
      maxBuySol: p.maxBuySol == null ? '' : String(p.maxBuySol),
      maxOpenPositions: p.maxOpenPositions == null ? '' : String(p.maxOpenPositions),
      active: p.active,
      autoBuyEnabled: p.autoBuyEnabled,
    });
  }

  async function save(key: string) {
    setBusy(true);
    try {
      await api.put('/admin/plans/' + key, {
        priceSol: Number(draft.priceSol),
        feePercent: draft.feePercent === '' ? null : Number(draft.feePercent),
        maxBuySol: draft.maxBuySol === '' ? null : Number(draft.maxBuySol),
        maxOpenPositions: draft.maxOpenPositions === '' ? null : Number(draft.maxOpenPositions),
        active: draft.active,
        autoBuyEnabled: draft.autoBuyEnabled,
      });
      setEditing(null);
      setRefresh((v) => v + 1);
    } catch (e) {
      window.alert(err(e));
    } finally {
      setBusy(false);
    }
  }

  const totals = q.data?.totals;
  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label={localize("Total revenue")} value={(totals?.revenueSol ?? 0).toFixed(3) + ' SOL'} tone="text-profit" />
      <Stat label={localize("Revenue / 30d")} value={(totals?.revenue30dSol ?? 0).toFixed(3) + ' SOL'} />
      <Stat label={localize("Paid subscribers")} value={String(totals?.paidSubscribers ?? 0)} sub={(totals?.users ?? 0) + ' total users'} />
      <Stat label={localize("Plan sales")} value={String(totals?.sales ?? 0)} />
    </div>
    <section className="card overflow-x-auto">
      <h2 className="mb-4 text-lg font-semibold text-white">{localize("Packages")}</h2>
      <table className="table-base min-w-[1000px]">
        <thead><tr><th>{localize("Plan")}</th><th>{localize("Price")}</th><th>{localize("Fee")}</th><th>{localize("Max buy")}</th><th>{localize("Max open")}</th><th>{localize("Subscribers")}</th><th>{localize("Revenue")}</th><th>{localize("Status")}</th><th /></tr></thead>
        <tbody>{(q.data?.plans ?? []).map((p) => <tr key={p.key}>
          <td><div className="font-medium text-slate-200">{p.name}</div><div className="text-[11px] text-slate-500">{p.key} · {p.durationDays}{" " + localize("days")}</div></td>
          <td>{editing === p.key ? <input className="input-field w-24" value={draft.priceSol} onChange={(e) => setDraft({...draft, priceSol:e.target.value})} /> : p.priceSol + ' SOL'}</td>
          <td>{editing === p.key ? <input className="input-field w-20" value={draft.feePercent} placeholder="global" onChange={(e) => setDraft({...draft, feePercent:e.target.value})} /> : (p.feeBps == null ? localize("Global") : p.feeBps / 100 + '%')}</td>
          <td>{editing === p.key ? <input className="input-field w-20" value={draft.maxBuySol} placeholder="∞" onChange={(e) => setDraft({...draft, maxBuySol:e.target.value})} /> : (p.maxBuySol ?? '∞')}</td>
          <td>{editing === p.key ? <input className="input-field w-20" value={draft.maxOpenPositions} placeholder="∞" onChange={(e) => setDraft({...draft, maxOpenPositions:e.target.value})} /> : (p.maxOpenPositions ?? '∞')}</td>
          <td>{p.activeSubscribers}</td>
          <td>{p.revenueSol.toFixed(3)} SOL</td>
          <td>{editing === p.key ? <div className="space-y-1 text-xs"><label className="flex gap-2"><input type="checkbox" checked={draft.active} onChange={(e)=>setDraft({...draft,active:e.target.checked})}/>{" " + localize("Visible")}</label><label className="flex gap-2"><input type="checkbox" checked={draft.autoBuyEnabled} onChange={(e)=>setDraft({...draft,autoBuyEnabled:e.target.checked})}/>{" " + localize("Auto-buy")}</label></div> : (p.active ? localize("Active") : localize("Hidden"))}</td>
          <td>{editing === p.key ? <div className="space-x-2"><button disabled={busy} className="text-xs text-profit" onClick={() => void save(p.key)}>{localize("Save")}</button><button className="text-xs text-slate-400" onClick={() => setEditing(null)}>{localize("Cancel")}</button></div> : <button className="text-xs text-violet-300" onClick={() => edit(p)}>{localize("Edit")}</button>}</td>
        </tr>)}</tbody>
      </table>
    </section>
  </div>;
}

type Withdrawal = { id: string; userId: string; amountUsd: number; destinationAddress: string; status: string; riskScore: number; requestedAt: string };
type Payout = { id: string; positionId: string; status: string; totalLamports: string; txSignature: string | null; failureReason: string | null; createdAt: string };
function Money() {
  const { t: localize } = useLanguage();
  const w = usePolling(() => api.get<Page<Withdrawal>>('/admin/withdrawals?limit=100'), 20000); const p = usePolling(() => api.get<Page<Payout>>('/admin/payouts?limit=100'), 20000);
  return <div className="space-y-5"><section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">{localize("Withdrawal queue")}</h2><table className="table-base min-w-[700px]"><thead><tr><th>{localize("Status")}</th><th>{localize("User")}</th><th>{localize("Amount")}</th><th>{localize("Destination")}</th><th>{localize("Risk")}</th></tr></thead><tbody>{(w.data?.rows ?? []).map((x) => <tr key={x.id}><td>{x.status}</td><td>{short(x.userId)}</td><td>{money(x.amountUsd)}</td><td>{short(x.destinationAddress)}</td><td>{x.riskScore.toFixed(0)}</td></tr>)}</tbody></table></section><section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">{localize("Payout attempts")}</h2><table className="table-base min-w-[700px]"><thead><tr><th>{localize("Status")}</th><th>{localize("Position")}</th><th>{localize("Total")}</th><th>{localize("TX / error")}</th></tr></thead><tbody>{(p.data?.rows ?? []).map((x) => <tr key={x.id}><td>{x.status}</td><td>{short(x.positionId)}</td><td>{(Number(x.totalLamports) / 1e9).toFixed(5)} SOL</td><td>{x.txSignature ? short(x.txSignature) : x.failureReason ?? '—'}</td></tr>)}</tbody></table></section></div>;
}
type AuditRow = { id: string; action: string; status: string; ip: string | null; createdAt: string; metadata: unknown; user: { email: string | null; telegramId: string | null } | null };
function Audit() {
  const { t: localize } = useLanguage();
  const q = usePolling(() => api.get<Page<AuditRow>>('/admin/audit?limit=150'), 20000);
  return <section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">{localize("Audit log")}</h2><table className="table-base min-w-[800px]"><thead><tr><th>{localize("Action")}</th><th>{localize("Status")}</th><th>{localize("Actor")}</th><th>{localize("IP")}</th><th>{localize("Time")}</th></tr></thead><tbody>{(q.data?.rows ?? []).map((x) => <tr key={x.id}><td>{x.action}</td><td>{x.status}</td><td>{x.user?.email ?? x.user?.telegramId ?? 'system'}</td><td>{x.ip ?? '—'}</td><td>{new Date(x.createdAt).toLocaleString()}</td></tr>)}</tbody></table></section>;
}
