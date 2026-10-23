import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PageHeading } from '../components/public/PublicLayout.js';
import { PUBLIC_API_BASE, SOL_MINT, money } from '../lib/publicMarket.js';
import { useLanguage } from '../lib/LanguageContext.js';

const TOOLS = [
  ['trending', 'Trending tokens', 'market'],
  ['hot-searches', 'Hot searches', 'market'],
  ['trenches', 'New token launches', 'market'],
  ['signal', 'Market signals', 'market'],
  ['search', 'Token & wallet search', 'search'],
  ['kline', 'Candlestick chart', 'address'],
  ['token-info', 'Token overview', 'address'],
  ['security', 'Token security', 'address'],
  ['pool', 'Liquidity pools', 'address'],
  ['holders', 'Top holders', 'address'],
  ['traders', 'Active traders', 'address'],
  ['holdings', 'Wallet holdings', 'wallet'],
  ['activity', 'Wallet activity', 'wallet'],
  ['stats', 'Wallet performance · 7d', 'wallet'],
  ['smartmoney', 'Smart money trades', 'market'],
  ['kol', 'KOL trades', 'market'],
] as const;
type Result = {
  tool: string;
  status: string;
  updatedAt?: number;
  retryAt?: number;
  requestLabel?: string;
  data: unknown;
};
const title = (key: string) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function displayValue(key: string, value: unknown) {
  const ratios = [
    'pnl',
    'profit_change',
    'amount_percentage',
    'top_10_holder_rate',
    'rug_ratio',
    'bundler_rate',
    'dev_team_hold_rate',
  ];
  if (ratios.includes(key) && value !== null && value !== '' && Number.isFinite(Number(value)))
    return `${(Number(value) * 100).toFixed(2)}%`;
  if ((key === 'timestamp' || key.endsWith('_timestamp')) && Number(value) > 1_000_000_000)
    return new Date(Number(value) * (Number(value) < 10_000_000_000 ? 1000 : 1)).toLocaleString();
  return valueText(value);
}
function valueText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(valueText).slice(0, 8).join(' · ');
  return (
    Object.entries(value as Record<string, unknown>)
      .slice(0, 5)
      .filter(([, v]) => v !== null && typeof v !== 'object')
      .map(([k, v]) => `${title(k)}: ${valueText(v)}`)
      .join(' · ') || 'Details below'
  );
}
function DataView({ data, depth = 0 }: { data: unknown; depth?: number }) {
  const { t: localize } = useLanguage();
  if (data === null || data === undefined)
    return <p className="source-note">{localize('No data returned.')}</p>;
  if (Array.isArray(data)) {
    if (!data.length) return <p className="source-note">{localize('No matching records.')}</p>;
    const rows = data.slice(0, 30);
    if (rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
      const preferred = [
        'symbol',
        'name',
        'address',
        'maker',
        'side',
        'price',
        'price_usd',
        'volume',
        'liquidity',
        'profit',
        'realized_profit',
        'unrealized_profit',
        'amount_usd',
        'timestamp',
      ];
      const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r as object))));
      const fields = [
        ...preferred.filter((k) => keys.includes(k)),
        ...keys.filter((k) => !preferred.includes(k)),
      ].slice(0, 8);
      return (
        <div className="table-scroll">
          <table className="nova-table">
            <thead>
              <tr>
                {fields.map((k) => (
                  <th key={k}>{title(k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {fields.map((k) => (
                    <td key={k} style={{ maxWidth: 260, overflowWrap: 'anywhere' }}>
                      {displayValue(k, (r as Record<string, unknown>)[k])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {data.length > 30 ? (
            <p className="source-note">
              {localize('Showing 30 of') + ' '}
              {data.length}
              {' ' + localize('returned records.')}
            </p>
          ) : null}
        </div>
      );
    }
    return (
      <ul className="source-note">
        {rows.map((v, i) => (
          <li key={i}>{valueText(v)}</li>
        ))}
      </ul>
    );
  }
  if (typeof data === 'object' && depth < 3)
    return (
      <div className="gmgn-result-grid">
        {Object.entries(data as Record<string, unknown>)
          .slice(0, 50)
          .map(([k, v]) => (
            <div className="gmgn-result-field" key={k}>
              <h3>{title(k)}</h3>
              {v && typeof v === 'object' ? (
                <DataView data={v} depth={depth + 1} />
              ) : (
                <p>{displayValue(k, v)}</p>
              )}
            </div>
          ))}
      </div>
    );
  return <p className="source-note">{valueText(data)}</p>;
}
function CandleChart({ data }: { data: unknown }) {
  const { t: localize } = useLanguage();
  const list =
    data && typeof data === 'object' && 'list' in data ? (data as { list: unknown }).list : data;
  if (!Array.isArray(list)) return <DataView data={data} />;
  const candles = list
    .map((v) => ({
      time: Number(v?.time),
      open: Number(v?.open),
      close: Number(v?.close),
      high: Number(v?.high),
      low: Number(v?.low),
    }))
    .filter(
      (c) =>
        Object.values(c).every(Number.isFinite) &&
        c.low > 0 &&
        c.high >= Math.max(c.open, c.close) &&
        c.low <= Math.min(c.open, c.close),
    )
    .sort((a, b) => a.time - b.time)
    .slice(-100);
  if (!candles.length)
    return <p className="source-note">{localize('No valid candles returned.')}</p>;
  const low = Math.min(...candles.map((c) => c.low)),
    high = Math.max(...candles.map((c) => c.high));
  const y = (p: number) => 240 - ((p - low) / (high - low || low * 0.01)) * 210;
  const width = 620 / candles.length;
  return (
    <div className="gmgn-chart">
      <svg
        viewBox="0 0 720 280"
        role="img"
        aria-label={`USD candlestick chart, ${candles.length} candles, low ${low}, high ${high}`}
      >
        <text x="4" y="20" fill="currentColor" fontSize="12">
          {money(high)}
        </text>
        <text x="4" y="245" fill="currentColor" fontSize="12">
          {money(low)}
        </text>
        {candles.map((c, i) => {
          const x = 85 + i * width,
            color = c.close >= c.open ? '#baf394' : '#ff7a87';
          return (
            <g key={`${c.time}-${i}`}>
              <title>
                {new Date(c.time * 1000).toLocaleString()} · O {c.open} H {c.high} L {c.low} C{' '}
                {c.close}
              </title>
              <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={color} />
              <rect
                x={x - width * 0.3}
                y={Math.min(y(c.open), y(c.close))}
                width={Math.max(1, width * 0.6)}
                height={Math.max(1, Math.abs(y(c.open) - y(c.close)))}
                fill={color}
              />
            </g>
          );
        })}
        <text x="85" y="270" fill="currentColor" fontSize="11">
          {new Date(candles[0]!.time * 1000).toLocaleTimeString()}
        </text>
        <text x="610" y="270" fill="currentColor" fontSize="11">
          {new Date(candles.at(-1)!.time * 1000).toLocaleTimeString()}
        </text>
      </svg>
    </div>
  );
}
export default function GmgnTools() {
  const { t: localize } = useLanguage();
  const [tool, setTool] = useState('trending'),
    [address, setAddress] = useState(SOL_MINT as string),
    [query, setQuery] = useState('');
  const [interval, setInterval] = useState('1h'),
    [resolution, setResolution] = useState('5m');
  const [result, setResult] = useState<Result>(),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);
  const selected = TOOLS.find((t) => t[0] === tool)!;
  async function submit(event: FormEvent) {
    event.preventDefault();
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    setResult(undefined);
    try {
      const body = {
        tool,
        interval,
        resolution,
        ...(['address', 'wallet'].includes(selected[2]) ? { address: address.trim() } : {}),
        ...(tool === 'search' ? { query: query.trim() } : {}),
      };
      const r = await fetch(`${PUBLIC_API_BASE}/public/gmgn/tools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      });
      if (!r.ok)
        throw new Error(
          r.status === 429
            ? 'Please wait before running another tool.'
            : 'Check your inputs and try again.',
        );
      const data = (await r.json()) as Result;
      if (!controller.signal.aborted)
        setResult({
          ...data,
          requestLabel: [
            selected[1],
            body.address ?? body.query ?? interval,
            tool === 'kline' ? resolution : '',
          ]
            .filter(Boolean)
            .join(' · '),
        });
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Connection interrupted');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  const statusMessage =
    result?.status === 'busy'
      ? 'Another request is running. Try again in a few seconds.'
      : result?.status === 'not_configured'
        ? 'GMGN is awaiting connection.'
        : result?.status === 'cooldown' || result?.status === 'unavailable'
          ? `GMGN is temporarily unavailable.${result.retryAt ? ' Retry after ' + new Date(result.retryAt).toLocaleTimeString() + '.' : ''}`
          : '';
  return (
    <div className="site-container interior-page">
      <PageHeading
        eyebrow={localize('GMGN RESEARCH WORKSPACE')}
        title={localize('Explore on-chain activity.')}
        text={localize('Market discovery, token research, charts and wallet analysis on Solana.')}
      />
      <div className="inline-cta">
        <Link className="text-link" to="/markets">
          {localize('Live prices & trending ↗')}
        </Link>
        <Link className="nova-button button-sm" to="/executions">
          {localize('My executed trades ↗')}
        </Link>
      </div>
      <section className="panel gmgn-tool-panel">
        <form onSubmit={submit} className="gmgn-tool-form">
          <label>
            {localize('Research tool')}
            <select
              value={tool}
              onChange={(e) => {
                request.current?.abort();
                setLoading(false);
                setTool(e.target.value);
                setResult(undefined);
                setError('');
              }}
            >
              {TOOLS.map(([value, label]) => (
                <option key={value} value={value}>
                  {localize(label)}
                </option>
              ))}
            </select>
          </label>
          {['address', 'wallet'].includes(selected[2]) ? (
            <label>
              {selected[2] === 'wallet' ? localize('Wallet address') : localize('Token address')}
              <input
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                pattern="[1-9A-HJ-NP-Za-km-z]{32,44}"
                spellCheck={false}
              />
            </label>
          ) : null}
          {tool === 'search' ? (
            <label>
              {localize('Token or wallet name')}
              <input
                required
                maxLength={80}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={localize('SOL or a Solana address')}
              />
            </label>
          ) : null}
          {tool === 'trending' || tool === 'hot-searches' ? (
            <label>
              {localize('Market window')}
              <select value={interval} onChange={(e) => setInterval(e.target.value)}>
                {['1m', '5m', '1h', '6h', '24h'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          ) : null}
          {tool === 'kline' ? (
            <label>
              {localize('Candle interval')}
              <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                {['1m', '5m', '15m', '1h', '4h', '1d'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          ) : null}
          <button className="nova-button" disabled={loading}>
            {loading ? localize('Loading…') : localize('Run research ↗')}
          </button>
        </form>
        <p className="source-note">
          {localize(
            'Research runs on demand. Wallet performance uses the last 7 days; charts cover the last 24 hours. Prices and provider labels are indicative.',
          )}
        </p>
      </section>
      <section className="panel gmgn-tool-panel" aria-live="polite" aria-busy={loading}>
        <h2>{selected[1]}</h2>
        {error ? (
          <p role="alert" className="inline-notice">
            {error}
          </p>
        ) : null}
        {statusMessage ? <p className="inline-notice">{statusMessage}</p> : null}
        {loading ? (
          <p className="source-note">{localize('Requesting current GMGN data…')}</p>
        ) : result?.status === 'connected' ? (
          <>
            <p className="source-note">
              {result.requestLabel}
              {' ' + localize('· Received') + ' '}
              {new Date(result.updatedAt!).toLocaleString()}
              {' ' + localize('· Source: GMGN')}
            </p>
            {result.tool === 'kline' ? (
              <CandleChart data={result.data} />
            ) : (
              <DataView data={result.data} />
            )}
          </>
        ) : !error && !statusMessage ? (
          <p className="source-note">
            {localize('Choose a tool and run research to view its results.')}
          </p>
        ) : null}
      </section>
    </div>
  );
}
