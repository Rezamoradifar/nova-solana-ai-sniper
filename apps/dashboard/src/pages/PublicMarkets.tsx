import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, PageHeading, TokenMark, useMarkets } from '../components/public/PublicLayout.js';
import { dexLabel, money, pct, poolUrl } from '../lib/publicMarket.js';

export default function PublicMarkets() {
  const { tokens, loading, error, updatedAt, refresh } = useMarkets();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('liquidity');
  const [selected, setSelected] = useState('SOL');
  const visible = useMemo(
    () =>
      tokens
        .filter((t) => `${t.symbol} ${t.name}`.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) =>
          sort === 'volume'
            ? b.volume - a.volume
            : sort === 'change'
              ? (b.change ?? -Infinity) - (a.change ?? -Infinity)
              : b.liquidity - a.liquidity,
        ),
    [tokens, query, sort],
  );
  const token = tokens.find((t) => t.symbol === selected) ?? tokens[0];
  const liquidity = tokens.reduce((n, t) => n + t.liquidity, 0),
    volume = tokens.reduce((n, t) => n + t.volume, 0),
    pools = tokens.reduce((n, t) => n + t.pairs.length, 0);
  return (
    <div className="site-container interior-page">
      <PageHeading
        eyebrow="SOLANA MARKET EXPLORER"
        title="The market. In focus."
        text="A considered view of prices, volume, and liquidity across selected Solana assets."
      >
        <span className={`status-pill ${error ? 'is-offline' : ''}`}>
          <span className={`status-dot ${error ? 'offline' : !tokens.length ? 'pending' : ''}`} />
          {error
            ? 'Connection interrupted'
            : tokens.length
              ? 'Market feed connected'
              : 'Connecting to source'}
        </span>
      </PageHeading>
      <div className="stat-grid">
        <div className="stat-card">
          <span>Observed liquidity</span>
          <strong>{tokens.length ? money(liquidity, true) : '—'}</strong>
          <small>Across returned pools</small>
        </div>
        <div className="stat-card">
          <span>24h pool volume</span>
          <strong>{tokens.length ? money(volume, true) : '—'}</strong>
          <small>Selected asset coverage</small>
        </div>
        <div className="stat-card">
          <span>Liquidity pools</span>
          <strong>{tokens.length ? pools : '—'}</strong>
          <small>{tokens.length} tracked assets</small>
        </div>
        <div className="stat-card">
          <span>Last refreshed</span>
          <strong className="stat-time">
            {updatedAt
              ? new Date(updatedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })
              : '—'}
          </strong>
          <small>Realtime price refresh every 2 seconds</small>
        </div>
      </div>
      <div className="panel market-panel">
        <div className="table-toolbar">
          <div>
            <h2>Market overview</h2>
            <p>Choose an asset to inspect its liquidity.</p>
          </div>
          <div className="toolbar-controls">
            <label className="search-field">
              <Icon name="search" size={18} />
              <input
                aria-label="Search assets"
                placeholder="Search assets…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <select
              aria-label="Sort markets"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="liquidity">By liquidity</option>
              <option value="volume">By volume</option>
              <option value="change">By 24h change</option>
            </select>
            <button
              className="icon-button"
              onClick={refresh}
              disabled={loading}
              aria-label="Refresh market data"
            >
              <Icon name="refresh" />
            </button>
          </div>
        </div>
        {error && (
          <div className="inline-notice">
            <Icon name="globe" size={18} />
            <span>
              {tokens.length ? 'Showing the last received prices. ' : ''}
              {error}
            </span>
          </div>
        )}
        <div className="table-scroll">
          <table className="nova-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Price</th>
                <th>24h change</th>
                <th>Observed liquidity</th>
                <th>24h pool volume</th>
                <th>Pools</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.mint} className={token?.mint === t.mint ? 'selected-row' : ''}>
                  <td>
                    <button
                      className="asset-cell"
                      onClick={() => setSelected(t.symbol)}
                      aria-pressed={token?.mint === t.mint}
                    >
                      <TokenMark symbol={t.symbol} color={t.color} />
                      <span>
                        <strong>{t.name}</strong>
                        <small>{t.symbol}</small>
                      </span>
                    </button>
                  </td>
                  <td
                    className={`number live-price ${t.tickDirection === 'up' ? 'tick-up' : t.tickDirection === 'down' ? 'tick-down' : ''}`}
                  >
                    <span>{money(t.price)}</span>
                    <small>
                      {t.tickDirection === 'up' ? '↑' : t.tickDirection === 'down' ? '↓' : '•'}{' '}
                      {pct(t.tickChangePercent)}
                    </small>
                  </td>
                  <td
                    className={`number ${t.change != null && t.change < 0 ? 'negative' : 'positive'}`}
                  >
                    {pct(t.change)}
                  </td>
                  <td className="number">{money(t.liquidity, true)}</td>
                  <td className="number muted">{money(t.volume, true)}</td>
                  <td>
                    <button
                      className="pool-count"
                      onClick={() => setSelected(t.symbol)}
                      aria-label={`Inspect ${t.symbol} pools`}
                    >
                      {t.pairs.length} ↗
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && (
            <div className="empty-state">
              <Icon name={loading ? 'refresh' : 'search'} size={32} />
              <h3>
                {loading && !tokens.length
                  ? 'Loading current markets'
                  : query
                    ? 'No matching assets'
                    : 'Waiting for market data'}
              </h3>
              <p>
                {query
                  ? 'Try a token name or symbol.'
                  : 'The table fills with current source data when a connection is available.'}
              </p>
              {query && (
                <button className="text-link" onClick={() => setQuery('')}>
                  Clear search
                </button>
              )}
            </div>
          )}
        </div>
        <div className="table-bottom">
          <span>
            {visible.length} of {tokens.length} assets
          </span>
          <span className="market-live-note">
            <i className="status-dot pulse" /> Repricing every 2s
          </span>
        </div>
      </div>
      <section className="pool-section">
        <div className="section-heading compact">
          <div>
            <div className="eyebrow">
              <span /> LOOK BENEATH THE PRICE
            </div>
            <h2>
              Liquidity explorer<span className="muted">.</span>
            </h2>
          </div>
          {token && (
            <a
              className="text-link"
              href={`https://solscan.io/token/${token.mint}`}
              target="_blank"
              rel="noreferrer"
            >
              {token.symbol} on Solscan ↗
            </a>
          )}
        </div>
        {token ? (
          <>
            <div className="selected-asset-label">
              <TokenMark symbol={token.symbol} color={token.color} />
              <span>
                <strong>{token.name} pools</strong>
                <small>Largest observed pools by liquidity</small>
              </span>
            </div>
            <div className="pool-grid">
              {token.pairs.slice(0, 6).map((p) => (
                <a
                  className="pool-card"
                  href={poolUrl(p)}
                  target="_blank"
                  rel="noreferrer"
                  key={p.pairAddress}
                >
                  <div>
                    <span className="pool-venue">{dexLabel(p.dexId)}</span>
                    <Icon name="external" size={16} />
                  </div>
                  <h3>
                    {p.baseToken.symbol} <span>/ {p.quoteToken.symbol}</span>
                  </h3>
                  <strong className="pool-price">{money(Number(p.priceUsd))}</strong>
                  <dl>
                    <div>
                      <dt>Liquidity</dt>
                      <dd>{money(p.liquidity?.usd, true)}</dd>
                    </div>
                    <div>
                      <dt>24h volume</dt>
                      <dd>{money(p.volume?.h24 ?? 0, true)}</dd>
                    </div>
                  </dl>
                  <span className="pool-address">
                    {p.pairAddress.slice(0, 7)}…{p.pairAddress.slice(-7)}
                  </span>
                </a>
              ))}
            </div>
          </>
        ) : (
          <div className="empty-state panel">
            <Icon name="layers" size={30} />
            <p>Select a market once prices are available to inspect its pools.</p>
          </div>
        )}
        <p className="source-note">
          A displayed pool price is indicative and is not a swap quote. Coverage includes only the
          pools returned by the source, with duplicates removed.
        </p>
      </section>
      <div className="inline-cta">
        <div>
          <span className="eyebrow">TAKE A DIFFERENT ANGLE</span>
          <h2>Compare the route behind the return.</h2>
        </div>
        <Link className="nova-button" to="/arbitrage">
          Open arbitrage terminal ↗
        </Link>
      </div>
    </div>
  );
}
