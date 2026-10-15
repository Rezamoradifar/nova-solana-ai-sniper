import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeading } from '../components/public/PublicLayout.js';
import { useAuth } from '../lib/AuthContext.js';
import { api } from '../lib/api.js';
import { money } from '../lib/publicMarket.js';
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
  if (authLoading) return <div className="site-container interior-page">Loading account…</div>;
  if (!user)
    return (
      <div className="site-container interior-page">
        <PageHeading
          eyebrow="EXECUTION HISTORY"
          title="Your trades. Your record."
          text="Sign in to view your confirmed trades and realized position results."
        />
        <Link className="nova-button" to="/login">
          Sign in ↗
        </Link>
      </div>
    );
  const admin = user.isAdmin || user.role === 'ADMIN';
  return (
    <div className="site-container interior-page">
      <PageHeading
        eyebrow="EXECUTION HISTORY"
        title="Executed trades & results."
        text="Confirmed buys and sells, with closed-position profit and loss shown separately."
      />
      <div className="gmgn-tool-form panel gmgn-tool-panel">
        <label>
          Trading mode
          <select value={mode} onChange={(e) => reset(setMode, e.target.value)}>
            <option value="live">Live trades</option>
            <option value="paper">Paper simulation</option>
          </select>
        </label>
        <label>
          Report
          <select value={view} onChange={(e) => reset(setView, e.target.value)}>
            <option value="trades">Confirmed buys & sells</option>
            <option value="positions">Closed positions · realized P&amp;L</option>
          </select>
        </label>
        {admin ? (
          <label>
            Accounts
            <select value={scope} onChange={(e) => reset(setScope, e.target.value)}>
              <option value="mine">My account</option>
              <option value="all">All accounts · admin</option>
            </select>
          </label>
        ) : null}
        <button
          className="nova-button button-sm"
          disabled={loading}
          onClick={() => setRefresh((n) => n + 1)}
        >
          Refresh
        </button>
        <Link className="text-link" to="/research">
          GMGN research ↗
        </Link>
      </div>
      {mode === 'paper' ? (
        <p className="inline-notice">
          Paper simulation · These records do not represent real fund movements.
        </p>
      ) : null}
      <div className="stat-grid">
        <div className="stat-card">
          <span>Confirmed executions</span>
          <strong>{data?.summary.confirmedTrades ?? '—'}</strong>
        </div>
        <div className="stat-card">
          <span>Closed positions</span>
          <strong>{data?.summary.closedPositions ?? '—'}</strong>
        </div>
        <div className="stat-card">
          <span>Recorded realized P&amp;L · USD</span>
          <strong>{money(data?.summary.realizedPnlUsd ?? undefined)}</strong>
          <small>All closed positions in the selected mode and account scope</small>
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
                <th>Time</th>
                <th>Token</th>
                <th>Wallet</th>
                {view === 'trades' ? (
                  <>
                    <th>Side</th>
                    <th>SOL amount</th>
                    <th>USD price</th>
                    <th>Transaction</th>
                  </>
                ) : (
                  <>
                    <th>Invested SOL</th>
                    <th>Realized P&amp;L · USD</th>
                    <th>Origin</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.closedAt ?? r.confirmedAt ?? r.createdAt).toLocaleString()}</td>
                  <td>{r.token.symbol ?? r.token.mint.slice(0, 8)}</td>
                  <td title={r.wallet.publicKey}>{r.wallet.label}</td>
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
                            View on Solscan ↗
                          </a>
                        ) : mode === 'paper' ? (
                          'Simulated'
                        ) : (
                          'Not recorded'
                        )}
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{r.amountSolInvested?.toFixed(5) ?? '—'}</td>
                      <td className={(r.realizedPnlUsd ?? 0) < 0 ? 'negative' : 'positive'}>
                        {money(r.realizedPnlUsd ?? undefined)}
                      </td>
                      <td>{r.copyTradeTargetAddress ? 'Copy trade' : 'Direct / automated'}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data?.rows.length ? (
          <div className="empty-state">
            {loading ? 'Loading executions…' : 'No completed records for this selection.'}
          </div>
        ) : null}
        <div className="table-bottom">
          <button
            className="text-link"
            disabled={!cursors.length || loading}
            onClick={() => setCursors((c) => c.slice(0, -1))}
          >
            ← Newer
          </button>
          <span>Page {cursors.length + 1} · refreshes every 10s</span>
          <button
            className="text-link"
            disabled={!data?.nextCursor || loading}
            onClick={() => {
              if (data?.nextCursor) setCursors((c) => [...c, data.nextCursor!]);
            }}
          >
            Older →
          </button>
        </div>
      </section>
    </div>
  );
}
