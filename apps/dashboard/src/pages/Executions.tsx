import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeading } from '../components/public/PublicLayout.js';
import { useAuth } from '../lib/AuthContext.js';
import { api } from '../lib/api.js';
import { money } from '../lib/publicMarket.js';
import { useLanguage } from '../lib/LanguageContext.js';
interface Row {
  id: string;
  side?: string;
  amountSol?: number;
  priceUsd?: number | null;
  txSignature?: string;
  createdAt: string;
  confirmedAt?: string;
  closedAt?: string;
  realizedPnlUsd?: number | null;
  amountSolInvested?: number;
  copyTradeTargetAddress?: string;
  token: { mint: string; symbol: string | null };
  wallet: { label: string; publicKey: string };
}
interface Report {
  rows: Row[];
  nextCursor: string | null;
  summary: { confirmedTrades: number; closedPositions: number; realizedPnlUsd: number | null };
}
export default function Executions() {
  const { t: localize } = useLanguage();
  const { user, loading: authLoading } = useAuth();
  const [mode, setMode] = useState('live'),
    [view, setView] = useState('trades'),
    [scope, setScope] = useState('mine');
  const [cursors, setCursors] = useState<string[]>([]),
    [storedData, setData] = useState<Report & { viewerId: string; filterKey: string }>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const cursor = cursors.at(-1) ?? '';
  const filterKey = `${mode}:${scope}:${view}:${cursor}`;
  const data =
    storedData && storedData.viewerId === user?.id && storedData.filterKey === filterKey
      ? storedData
      : undefined;
  useEffect(() => {
    if (!user) return;
    const version = ++generation.current;
    let cancelled = false,
      inFlight = false;
    setData(undefined);
    setError('');
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      setLoading(true);
      try {
        const params = new URLSearchParams({ mode, view, scope, ...(cursor ? { cursor } : {}) });
        const report = await api.get<Report>(`/executions?${params}`);
        if (!cancelled && version === generation.current) {
          setData({ ...report, viewerId: user.id, filterKey });
          setError('');
        }
      } catch {
        if (!cancelled) setError('Could not load execution history. Try again.');
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [user, mode, view, scope, cursor, filterKey, refresh]);
  function reset(set: (s: string) => void, value: string) {
    setCursors([]);
    set(value);
  }
  if (authLoading)
    return <div className="site-container interior-page">{localize('Loading account…')}</div>;
  if (!user)
    return (
      <div className="site-container interior-page">
        <PageHeading
          eyebrow={localize('EXECUTION HISTORY')}
          title={localize('Your trades. Your record.')}
          text={localize('Sign in to view your confirmed trades and realized position results.')}
        />
        <Link className="nova-button" to="/login">
          {localize('Sign in ↗')}
        </Link>
      </div>
    );
  const admin = user.isAdmin || user.role === 'ADMIN';
  return (
    <div className="site-container interior-page">
      <PageHeading
        eyebrow={localize('EXECUTION HISTORY')}
        title={localize('Executed trades & results.')}
        text={localize(
          'Confirmed buys and sells, with closed-position profit and loss shown separately.',
        )}
      />
      <div className="gmgn-tool-form panel gmgn-tool-panel">
        <label>
          {localize('Trading mode')}
          <select value={mode} onChange={(e) => reset(setMode, e.target.value)}>
            <option value="live">{localize('Live trades')}</option>
            <option value="paper">{localize('Paper simulation')}</option>
          </select>
        </label>
        <label>
          {localize('Report')}
          <select value={view} onChange={(e) => reset(setView, e.target.value)}>
            <option value="trades">{localize('Confirmed buys & sells')}</option>
            <option value="positions">{localize('Closed positions · realized P&L')}</option>
          </select>
        </label>
        {admin ? (
          <label>
            {localize('Accounts')}
            <select value={scope} onChange={(e) => reset(setScope, e.target.value)}>
              <option value="mine">{localize('My account')}</option>
              <option value="all">{localize('All accounts · admin')}</option>
            </select>
          </label>
        ) : null}
        <button
          className="nova-button button-sm"
          disabled={loading}
          onClick={() => setRefresh((n) => n + 1)}
        >
          {localize('Refresh')}
        </button>
        <Link className="text-link" to="/research">
          {localize('GMGN research ↗')}
        </Link>
      </div>
      {mode === 'paper' ? (
        <p className="inline-notice">
          {localize('Paper simulation · These records do not represent real fund movements.')}
        </p>
      ) : null}
      <div className="stat-grid">
        <div className="stat-card">
          <span>{localize('Confirmed executions')}</span>
          <strong>{data?.summary.confirmedTrades ?? '—'}</strong>
        </div>
        <div className="stat-card">
          <span>{localize('Closed positions')}</span>
          <strong>{data?.summary.closedPositions ?? '—'}</strong>
        </div>
        <div className="stat-card">
          <span>{localize('Recorded realized P&L · USD')}</span>
          <strong>{money(data?.summary.realizedPnlUsd ?? undefined)}</strong>
          <small>{localize('All closed positions in the selected mode and account scope')}</small>
        </div>
      </div>
      {error ? (
        <p role="alert" className="inline-notice">
          {error}
        </p>
      ) : null}
      <section className="panel" aria-busy={loading}>
        <div className="table-scroll">
          <table className="nova-table">
            <thead>
              <tr>
                <th>{localize('Time')}</th>
                <th>{localize('Token')}</th>
                <th>{localize('Wallet')}</th>
                {view === 'trades' ? (
                  <>
                    <th>{localize('Side')}</th>
                    <th>{localize('SOL amount')}</th>
                    <th>{localize('USD price')}</th>
                    <th>{localize('Transaction')}</th>
                  </>
                ) : (
                  <>
                    <th>{localize('Invested SOL')}</th>
                    <th>{localize('Realized P&L · USD')}</th>
                    <th>{localize('Origin')}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.closedAt ?? r.confirmedAt ?? r.createdAt).toLocaleString()}</td>
                  <td>{r.token.symbol ?? r.token.mint.slice(0, 8)}</td>
                  <td title={r.wallet.publicKey}>{localize(r.wallet.label)}</td>
                  {view === 'trades' ? (
                    <>
                      <td>{r.side}</td>
                      <td>{r.amountSol?.toFixed(5) ?? '—'}</td>
                      <td>{money(r.priceUsd ?? undefined)}</td>
                      <td>
                        {mode === 'live' &&
                        r.txSignature &&
                        /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(r.txSignature) ? (
                          <a
                            className="text-link"
                            href={`https://solscan.io/tx/${r.txSignature}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {localize('View on Solscan ↗')}
                          </a>
                        ) : mode === 'paper' ? (
                          localize('Simulated')
                        ) : (
                          localize('Not recorded')
                        )}
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{r.amountSolInvested?.toFixed(5) ?? '—'}</td>
                      <td className={(r.realizedPnlUsd ?? 0) < 0 ? 'negative' : 'positive'}>
                        {money(r.realizedPnlUsd ?? undefined)}
                      </td>
                      <td>
                        {r.copyTradeTargetAddress
                          ? localize('Copy trade')
                          : localize('Direct / automated')}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data?.rows.length ? (
          <div className="empty-state">
            {loading
              ? localize('Loading executions…')
              : localize('No completed records for this selection.')}
          </div>
        ) : null}
        <div className="table-bottom">
          <button
            className="text-link"
            disabled={!cursors.length || loading}
            onClick={() => setCursors((c) => c.slice(0, -1))}
          >
            {localize('← Newer')}
          </button>
          <span>
            {localize('Page') + ' '}
            {cursors.length + 1}
            {' ' + localize('· refreshes every 10s')}
          </span>
          <button
            className="text-link"
            disabled={!data?.nextCursor || loading}
            onClick={() => {
              if (data?.nextCursor) setCursors((c) => [...c, data.nextCursor!]);
            }}
          >
            {localize('Older →')}
          </button>
        </div>
      </section>
    </div>
  );
}
