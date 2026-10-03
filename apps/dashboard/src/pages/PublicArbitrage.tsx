import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon, PageHeading, TokenMark } from '../components/public/PublicLayout.js';
import {
  ARB_DEXES,
  ARB_TOKENS,
  isRouteFresh,
  routesCsv,
  scanLiveRoutes,
  type LiveRoute,
  type ScanInput,
  type ScanProgress,
} from '../lib/liveArbitrage.js';
import { PUBLIC_API_BASE, pct } from '../lib/publicMarket.js';

const INITIAL: ScanInput = {
  token: ARB_TOKENS[0],
  amountSol: 0.5,
  costSol: 0.000205,
  bufferBps: 10,
};
const sol = (value: number, signed = false) =>
  `${signed && value > 0 ? '+' : ''}${value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
const clock = (at: number | null) =>
  at
    ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';
const age = (route: LiveRoute, now: number) =>
  Math.max(0, Math.floor((now - route.buyQuoteAt) / 1000));

export default function PublicArbitrage() {
  const [config, setConfig] = useState<ScanInput>(INITIAL);
  const [tokenSymbol, setTokenSymbol] = useState<string>('USDC');
  const [amount, setAmount] = useState('0.5');
  const [cost, setCost] = useState('0.000205');
  const [buffer, setBuffer] = useState('10');
  const [active, setActive] = useState(true);
  const [visible, setVisible] = useState(!document.hidden);
  const [revision, setRevision] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [routes, setRoutes] = useState<LiveRoute[]>([]);
  const [progress, setProgress] = useState<ScanProgress>({
    phase: 'Preparing direct route quotes',
    completed: 0,
    total: 9,
    failed: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<number | null>(null);
  const [nextScan, setNextScan] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [positiveOnly, setPositiveOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [worker, setWorker] = useState('Checking connection');
  const detailsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  useEffect(() => {
    if (!active || !visible) {
      setScanning(false);
      setNextScan(null);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      setScanning(true);
      setError(null);
      setRoutes([]);
      setSelectedId(null);
      setNextScan(null);
      setProgress({ phase: 'Connecting to Jupiter', completed: 0, total: 9, failed: 0 });
      try {
        const result = await scanLiveRoutes(
          config,
          controller.signal,
          (p) => {
            if (!controller.signal.aborted) setProgress(p);
          },
          (route) => {
            if (!controller.signal.aborted)
              setRoutes((previous) =>
                [...previous.filter((r) => r.id !== route.id), route].sort(
                  (a, b) => b.estimatedNetSol - a.estimatedNetSol,
                ),
              );
          },
        );
        if (controller.signal.aborted) return;
        setRoutes(result);
        setLastScan(Date.now());
        if (!result.length)
          setError(
            'No valid direct round trip returned for this scan. A venue may have no route, or the source may be temporarily unavailable.',
          );
      } catch (e: unknown) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Quote connection interrupted.');
      } finally {
        if (!controller.signal.aborted) {
          setScanning(false);
          setNextScan(Date.now() + 60_000);
          timer = setTimeout(() => void run(), 60_000);
        }
      }
    };
    void run();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [active, visible, config, revision]);
  useEffect(() => {
    const controller = new AbortController();
    const check = () => {
      if (document.hidden) return;
      fetch(`${PUBLIC_API_BASE}/public/arbitrage`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      })
        .then(async (r) => {
          if (!r.ok) throw new Error();
          return r.json() as Promise<{ status?: unknown; mode?: unknown }>;
        })
        .then((r) => {
          if (!controller.signal.aborted)
            setWorker(
              r.mode === 'observation' &&
                typeof r.status === 'string' &&
                ['disabled', 'starting', 'ready', 'stale', 'unavailable'].includes(r.status)
                ? r.status[0]!.toUpperCase() + r.status.slice(1)
                : 'Not linked',
            );
        })
        .catch(() => {
          if (!controller.signal.aborted) setWorker('Not linked');
        });
    };
    check();
    const timer = setInterval(check, 60_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  const displayed = useMemo(
    () => routes.filter((r) => !positiveOnly || r.estimatedNetSol > 0),
    [routes, positiveOnly],
  );
  const best = routes[0];
  const freshRoutes = routes.filter((r) => isRouteFresh(r, now));
  const selected = routes.find((r) => r.id === selectedId) ?? best;
  const status = !visible
    ? 'Tab paused'
    : !active
      ? 'Paused'
      : scanning
        ? 'Scanning'
        : freshRoutes.length
          ? 'Quotes received'
          : error
            ? 'Source unavailable'
            : routes.length
              ? 'Quotes aging'
              : 'Waiting';
  const apply = (event: FormEvent) => {
    event.preventDefault();
    const token = ARB_TOKENS.find((t) => t.symbol === tokenSymbol);
    if (!token) return;
    const amountSol = Number(amount),
      costSol = Number(cost),
      bufferBps = Number(buffer);
    if (
      !amount.trim() ||
      !cost.trim() ||
      !buffer.trim() ||
      !Number.isFinite(amountSol) ||
      amountSol < 0.01 ||
      amountSol > 10 ||
      !Number.isFinite(costSol) ||
      costSol < 0 ||
      costSol > 0.1 ||
      !Number.isInteger(bufferBps) ||
      bufferBps < 0 ||
      bufferBps > 500
    ) {
      setError(
        'Enter an amount from 0.01 to 10 SOL, a cost budget from 0 to 0.1 SOL, and an integer buffer from 0 to 500 bps.',
      );
      return;
    }
    setConfig({ token, amountSol, costSol, bufferBps });
    setActive(true);
  };
  const download = () => {
    if (!routes.length) return;
    const url = URL.createObjectURL(
      new Blob([routesCsv(routes)], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `gsp-arbitrage-observations-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="site-container interior-page arbitrage-page">
      <PageHeading
        eyebrow="LIVE ARBITRAGE INTELLIGENCE"
        title="Find the spread. Know the cost."
        text="Compare real, direct Solana quotes across venues. Inspect each route with its costs, assumptions, and timestamp."
      >
        <span className="observation-badge">
          <Icon name="scan" size={17} /> Observation only
        </span>
      </PageHeading>
      <div className="terminal-statusbar">
        <div>
          <span
            className={`status-dot ${error && !scanning ? 'offline' : scanning ? 'pulse' : !active || !visible ? 'pending' : freshRoutes.length ? '' : 'pending'}`}
          />
          <strong>{status}</strong>
          <span className="statusbar-divider" />
          <span>Solana mainnet</span>
          <span className="statusbar-divider" />
          <span>Jupiter quotes</span>
        </div>
        <div>
          <span className="desktop-only">No wallet required</span>
          <button className="text-link" onClick={() => setActive(!active)}>
            <Icon name={active ? 'pause' : 'play'} size={15} />
            {active ? 'Pause scanner' : 'Resume scanner'}
          </button>
        </div>
      </div>
      <div className="terminal-grid">
        <aside className="scan-sidebar panel">
          <div className="panel-label">
            <span>
              <Icon name="sliders" size={17} /> Scan settings
            </span>
            <span className="subtle-label">01</span>
          </div>
          <form onSubmit={apply}>
            <label className="field-label" htmlFor="arb-asset">
              Intermediate asset
            </label>
            <div className="asset-select">
              <TokenMark symbol={tokenSymbol} color="#a5c6ff" />
              <select
                id="arb-asset"
                value={tokenSymbol}
                onChange={(e) => setTokenSymbol(e.target.value)}
              >
                {ARB_TOKENS.map((t) => (
                  <option value={t.symbol} key={t.mint}>
                    {t.symbol} · {t.name}
                  </option>
                ))}
              </select>
            </div>
            <label className="field-label" htmlFor="arb-amount">
              Starting amount
            </label>
            <div className="input-unit">
              <input
                id="arb-amount"
                type="number"
                inputMode="decimal"
                min="0.01"
                max="10"
                step="0.01"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <span>SOL</span>
            </div>
            <div className="quick-amounts">
              {['0.1', '0.5', '1', '5'].map((v) => (
                <button
                  type="button"
                  key={v}
                  className={amount === v ? 'selected' : ''}
                  onClick={() => setAmount(v)}
                >
                  {v}
                </button>
              ))}
            </div>
            <div className="settings-divider" />
            <label className="field-label" htmlFor="arb-cost">
              Network-cost budget <span>ESTIMATE</span>
            </label>
            <div className="input-unit">
              <input
                id="arb-cost"
                type="number"
                inputMode="decimal"
                min="0"
                max="0.1"
                step="0.000001"
                required
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
              <span>SOL</span>
            </div>
            <p className="field-help">Your combined fee and tip assumption for the round trip.</p>
            <label className="field-label" htmlFor="arb-buffer">
              Additional safety buffer
            </label>
            <div className="input-unit">
              <input
                id="arb-buffer"
                type="number"
                inputMode="numeric"
                min="0"
                max="500"
                step="1"
                required
                value={buffer}
                onChange={(e) => setBuffer(e.target.value)}
              />
              <span>bps</span>
            </div>
            <p className="field-help">10 bps = 0.10% of the starting amount.</p>
            <button className="nova-button full-width" type="submit">
              <Icon name="scan" size={17} /> Apply & scan
            </button>
          </form>
          <div className="scan-venues">
            <span className="field-label">Venues in this scan</span>
            {ARB_DEXES.map((d) => (
              <div key={d}>
                <span className="venue-indicator" />
                {d === 'Whirlpool' ? 'Orca Whirlpool' : d}
                <Icon name="check" size={14} />
              </div>
            ))}
          </div>
          <div className="sidebar-note">
            <Icon name="shield" size={18} />
            <p>This terminal requests quotes. It does not connect a wallet or execute trades.</p>
          </div>
        </aside>
        <div className="terminal-main">
          <div className="terminal-stats">
            <div className="terminal-stat">
              <span>Best estimated net</span>
              <strong
                className={best ? (best.estimatedNetSol > 0 ? 'positive' : 'negative') : 'muted'}
              >
                {best ? sol(best.estimatedNetSol, true) : '—'}
                {best && <small> SOL</small>}
              </strong>
              <small>
                {best
                  ? `${pct(best.estimatedNetPercent)} after configured costs`
                  : 'Waiting for a complete route'}
              </small>
            </div>
            <div className="terminal-stat">
              <span>Valid route observations</span>
              <strong>
                {routes.length}
                <small> / 6</small>
              </strong>
              <small>{freshRoutes.length} currently within 45 seconds</small>
            </div>
            <div className="terminal-stat">
              <span>Next scan</span>
              <strong className="stat-time">
                {scanning
                  ? 'In progress'
                  : nextScan
                    ? `${Math.max(0, Math.ceil((nextScan - now) / 1000))}s`
                    : 'Paused'}
              </strong>
              <small>Last completed: {clock(lastScan)}</small>
            </div>
          </div>
          <div className="scan-progress">
            <div>
              <span className={scanning ? 'spinner-dot' : ''} />
              <span role="status">
                {scanning
                  ? progress.phase
                  : !active
                    ? 'Scanner paused. Your observations remain available.'
                    : !visible
                      ? 'Scanning pauses while this tab is hidden.'
                      : progress.phase}
              </span>
              <span>
                {progress.completed}/{progress.total}
              </span>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-label="Quote scan progress"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.completed}
            >
              <span style={{ width: `${(progress.completed / progress.total) * 100}%` }} />
            </div>
          </div>
          <div className="panel routes-panel">
            <div className="table-toolbar">
              <div>
                <h2>
                  Route observations <span className="count-badge">{routes.length}</span>
                </h2>
                <p>
                  SOL → {config.token.symbol} → SOL · {sol(config.amountSol)} SOL
                </p>
              </div>
              <div className="toolbar-controls">
                <button
                  className={`filter-chip ${positiveOnly ? 'selected' : ''}`}
                  aria-pressed={positiveOnly}
                  onClick={() => setPositiveOnly(!positiveOnly)}
                >
                  Positive estimates
                </button>
                <button
                  className="icon-button"
                  aria-label="Export current observations as CSV"
                  onClick={download}
                  disabled={!routes.length}
                >
                  <Icon name="download" size={18} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Restart scan"
                  onClick={() => {
                    setActive(true);
                    setRevision((v) => v + 1);
                  }}
                >
                  <Icon name="refresh" size={18} />
                </button>
              </div>
            </div>
            {error && (
              <div className="inline-notice">
                <Icon name="globe" size={18} />
                <span>{error}</span>
              </div>
            )}
            <div className="table-scroll">
              <table className="nova-table route-table">
                <thead>
                  <tr>
                    <th>Route · buy → sell</th>
                    <th>Min. return</th>
                    <th>Est. net</th>
                    <th>Quote age</th>
                    <th>
                      <span className="sr-only">Inspect</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map((r) => {
                    const fresh = isRouteFresh(r, now);
                    return (
                      <tr key={r.id} className={selected?.id === r.id ? 'selected-row' : ''}>
                        <td>
                          <button
                            className="route-pair"
                            aria-label={`Inspect ${r.buyDex} to ${r.sellDex}`}
                            onClick={() => setSelectedId(r.id)}
                          >
                            <span>
                              <i className="venue-indicator" />
                              {r.buyDex === 'Whirlpool' ? 'Orca Whirlpool' : r.buyDex}
                            </span>
                            <span className="muted">
                              <span className="route-turn">↳</span>
                              {r.sellDex === 'Whirlpool' ? 'Orca Whirlpool' : r.sellDex}
                            </span>
                          </button>
                        </td>
                        <td className="number">
                          {sol(r.outputSol)}
                          <small className="cell-subtext">SOL</small>
                        </td>
                        <td className={`number ${r.estimatedNetSol > 0 ? 'positive' : 'negative'}`}>
                          {sol(r.estimatedNetSol, true)}
                          <small className="cell-subtext">{pct(r.estimatedNetPercent)}</small>
                        </td>
                        <td>
                          <span className={`quote-age ${fresh ? '' : 'stale'}`}>
                            {age(r, now)}s {fresh ? '' : '· Stale'}
                          </span>
                        </td>
                        <td>
                          <button
                            className="table-link"
                            aria-label={`View route details for ${r.buyDex} to ${r.sellDex}`}
                            onClick={() => {
                              setSelectedId(r.id);
                              detailsRef.current?.scrollIntoView({
                                behavior: 'smooth',
                                block: 'nearest',
                              });
                            }}
                          >
                            ↗
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!displayed.length && (
                <div className="empty-state route-empty">
                  <span className={`scanner-visual ${scanning ? 'is-scanning' : ''}`}>
                    <Icon name="scan" size={33} />
                  </span>
                  <h3>
                    {scanning
                      ? 'Reading the routes'
                      : positiveOnly && routes.length
                        ? 'No positive estimates in this scan'
                        : !active
                          ? 'Ready when you are'
                          : 'No route observations yet'}
                  </h3>
                  <p>
                    {scanning
                      ? 'Quotes appear as each two-venue route completes. A scan can take around 20–45 seconds.'
                      : positiveOnly && routes.length
                        ? 'Current costs and minimum quote outputs leave the observed routes below break-even.'
                        : 'Start a scan or adjust the asset and amount to request fresh quotes.'}
                  </p>
                  {positiveOnly && routes.length > 0 && (
                    <button className="text-link" onClick={() => setPositiveOnly(false)}>
                      Show all observations ↗
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="table-bottom">
              <span>
                {progress.failed > 0
                  ? `${progress.failed} quote requests unavailable`
                  : 'Direct routes only · 50 bps slippage per leg'}
              </span>
              <span>Estimates, not executed returns</span>
            </div>
          </div>
          <div ref={detailsRef} className="route-details panel">
            <div className="panel-label">
              <span>
                <Icon name="layers" size={17} /> Route breakdown
              </span>
              {selected && <span className="subtle-label">{clock(selected.observedAt)}</span>}
            </div>
            {selected ? (
              <>
                <div className="breakdown-heading">
                  <div className="breakdown-route">
                    <TokenMark symbol="SOL" />
                    <span>
                      SOL <i>→</i> {selected.token} <i>→</i> SOL
                    </span>
                  </div>
                  <span
                    className={`outline-tag ${!isRouteFresh(selected, now) ? 'tag-stale' : ''}`}
                  >
                    {!isRouteFresh(selected, now) ? 'STALE OBSERVATION' : 'QUOTE OBSERVATION'}
                  </span>
                </div>
                <div className="breakdown-grid">
                  <dl className="cost-breakdown">
                    <div>
                      <dt>Starting amount</dt>
                      <dd>{sol(selected.inputSol)} SOL</dd>
                    </div>
                    <div>
                      <dt>Minimum quoted return</dt>
                      <dd>{sol(selected.outputSol)} SOL</dd>
                    </div>
                    <div>
                      <dt>Gross difference</dt>
                      <dd className={selected.grossSol > 0 ? 'positive' : 'negative'}>
                        {sol(selected.grossSol, true)} SOL
                      </dd>
                    </div>
                    <div>
                      <dt>Network-cost budget</dt>
                      <dd>−{sol(selected.costSol)} SOL</dd>
                    </div>
                    <div>
                      <dt>Additional buffer</dt>
                      <dd>−{sol(selected.bufferSol)} SOL</dd>
                    </div>
                    <div className="breakdown-total">
                      <dt>Estimated net result</dt>
                      <dd className={selected.estimatedNetSol > 0 ? 'positive' : 'negative'}>
                        {sol(selected.estimatedNetSol, true)} SOL
                      </dd>
                    </div>
                  </dl>
                  <div className="quote-context">
                    <span className="eyebrow">QUOTE CONTEXT</span>
                    <p>
                      The exit quote uses the first leg’s minimum output. Both quotes include a 50
                      bps slippage setting; your extra buffer and cost budget are deducted
                      separately.
                    </p>
                    <dl>
                      <div>
                        <dt>Buy venue</dt>
                        <dd>{selected.buyDex}</dd>
                      </div>
                      <div>
                        <dt>Sell venue</dt>
                        <dd>{selected.sellDex}</dd>
                      </div>
                      <div>
                        <dt>Buy / sell slots</dt>
                        <dd>
                          {selected.buyQuote.contextSlot} / {selected.sellQuote.contextSlot}
                        </dd>
                      </div>
                    </dl>
                    <a
                      className="text-link"
                      href={`https://solscan.io/token/${selected.mint}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Inspect {selected.token} token ↗
                    </a>
                  </div>
                </div>
                <p className="source-note">
                  The quotes are sequential and do not reserve liquidity. A displayed estimate does
                  not establish that the route can execute atomically or profitably.
                </p>
              </>
            ) : (
              <div className="empty-details">
                <Icon name="layers" size={26} />
                <p>
                  Select an observed route to see both venues, quote context, and the complete cost
                  breakdown.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="terminal-footnotes">
        <details>
          <summary>
            Data sources & connection details <Icon name="chevron" size={16} />
          </summary>
          <div>
            <p>
              <strong>Public terminal:</strong> direct Jupiter quote requests, spaced at least 2.2
              seconds apart. Scans refresh 60 seconds after completion and pause when the tab is
              hidden. Results older than 45 seconds are marked stale.
            </p>
            <p>
              <strong>Background bot scanner:</strong> {worker}. This separate service reports its
              own state when connected. Public quote scanning does not depend on that worker.
            </p>
            <p>
              <strong>Trading execution:</strong> disabled in this public terminal. Market estimates
              are not confirmed transactions.
            </p>
            <a
              href="https://developers.jup.ag/docs/api-reference/swap/v1/quote"
              className="text-link"
              target="_blank"
              rel="noreferrer"
            >
              Quote source documentation ↗
            </a>
          </div>
        </details>
        <div className="button-row">
          <Link className="text-link" to="/flash-arbitrage">
            Open Flash Loan Lab ↗
          </Link>
          <Link className="text-link" to="/security">
            Understand risk & custody ↗
          </Link>
        </div>
      </div>
    </div>
  );
}
