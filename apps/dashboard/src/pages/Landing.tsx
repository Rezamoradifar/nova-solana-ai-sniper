import { Link } from 'react-router-dom';
import { Icon, MarketTicker, TokenMark, useMarkets } from '../components/public/PublicLayout.js';
import { money, pct } from '../lib/publicMarket.js';
import { WebsiteTools } from '../components/public/WebsiteTools.js';
import { NetworkWinners } from '../components/public/NetworkWinners.js';
import { useLanguage } from '../lib/LanguageContext.js';

export default function Landing() {
  const { t: localize } = useLanguage();
  const { tokens, loading, error, updatedAt, refresh } = useMarkets();
  return (
    <>
      <section className="ml-hero" aria-labelledby="ml-hero-title">
        <div className="ml-hero-grid-overlay" aria-hidden="true" />
        <div className="site-container ml-hero-grid">
          <div className="ml-hero-copy">
            <div className="ml-hero-chip">
              <span className="ml-hero-signal" />
              {localize('SOLANA OPERATIONS INTELLIGENCE')}
              <span className="ml-chip-divider" />
              {localize('01 / MONEYLAND')}
            </div>
            <p className="ml-hero-overline">{localize('GSP TRADING / OBSERVE · EVALUATE · ACT')}</p>
            <h1 id="ml-hero-title">
              {localize('Read the market.')}
              <br />
              <span>{localize('Own the next move.')}</span>
            </h1>
            <p className="ml-hero-lead">
              {localize(
                'Your command center for Solana markets, cross-venue route analysis, and informed trading decisions. See the data, understand the assumptions, then decide what happens next.',
              )}
            </p>
            <div className="button-row ml-hero-actions">
              <Link className="nova-button ml-primary-action" to="/arbitrage">
                {localize('Explore the terminal') + ' '}
                <Icon name="external" size={16} />
              </Link>
              <Link className="nova-button button-outline ml-secondary-action" to="/markets">
                {localize('View live markets') + ' '}
                <span aria-hidden="true">↗</span>
              </Link>
            </div>
            <div className="ml-hero-footnotes">
              <span>
                <Icon name="check" size={15} />
                {' ' + localize('Public market research')}
              </span>
              <span>
                <Icon name="check" size={15} />
                {' ' + localize('Transparent route assumptions')}
              </span>
              <span>
                <Icon name="check" size={15} />
                {' ' + localize('Risk-aware tools')}
              </span>
            </div>
          </div>
          <div className="ml-console" aria-label={localize('GSP trading observation console')}>
            <div className="ml-console-topbar">
              <div className="ml-console-identity">
                <span className="ml-console-emblem" aria-hidden="true">
                  ◈
                </span>
                <span>
                  <strong>{localize('GSP / MARKET MIRROR')}</strong>
                  <small>{localize('READ-ONLY OBSERVATION LAYER')}</small>
                </span>
              </div>
              <span
                className={
                  tokens.length
                    ? 'ml-feed-status ml-feed-ready'
                    : error
                      ? 'ml-feed-status ml-feed-error'
                      : 'ml-feed-status ml-feed-wait'
                }
              >
                <span className="ml-status-signal" />
                {tokens.length
                  ? localize('FEED CONNECTED')
                  : error
                    ? localize('SOURCE UNAVAILABLE')
                    : localize('CONNECTING')}
              </span>
            </div>
            <div className="ml-console-body">
              <div className="ml-monitor">
                <div className="ml-monitor-header">
                  <span>{localize('NETWORK TOPOLOGY')}</span>
                  <span>{localize('VIEW · SOLANA')}</span>
                </div>
                <div className="ml-monitor-art" aria-hidden="true">
                  <svg viewBox="0 0 480 420" fill="none" preserveAspectRatio="xMidYMid meet">
                    <defs>
                      <pattern id="ml-grid" width="28" height="28" patternUnits="userSpaceOnUse">
                        <path d="M28 0H0V28" stroke="#5a8371" strokeOpacity=".12" strokeWidth="1" />
                      </pattern>
                      <linearGradient
                        id="ml-arc"
                        x1="54"
                        y1="190"
                        x2="442"
                        y2="230"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="#8be5b8" stopOpacity=".16" />
                        <stop offset=".5" stopColor="#c5f5a2" />
                        <stop offset="1" stopColor="#6de0cf" stopOpacity=".25" />
                      </linearGradient>
                    </defs>
                    <rect width="480" height="420" fill="url(#ml-grid)" />
                    <circle
                      cx="240"
                      cy="212"
                      r="145"
                      stroke="#72958a"
                      strokeOpacity=".25"
                      strokeDasharray="3 8"
                    />
                    <circle cx="240" cy="212" r="103" stroke="#a8f5b8" strokeOpacity=".16" />
                    <circle
                      cx="240"
                      cy="212"
                      r="60"
                      stroke="#a8f5b8"
                      strokeOpacity=".18"
                      strokeDasharray="4 7"
                    />
                    <path
                      d="M76 263L174 148L290 225L393 118"
                      stroke="url(#ml-arc)"
                      strokeWidth="2"
                    />
                    <path
                      d="M76 263L240 310L393 118"
                      stroke="#79c0bc"
                      strokeOpacity=".38"
                      strokeDasharray="5 9"
                    />
                    <path
                      d="M174 148L240 310L290 225"
                      stroke="#7fd9a8"
                      strokeOpacity=".38"
                      strokeDasharray="4 8"
                    />
                    <circle cx="76" cy="263" r="6" fill="#83dbc0" />
                    <circle cx="174" cy="148" r="8" fill="#c3f0a0" />
                    <circle cx="290" cy="225" r="9" fill="#c3f0a0" />
                    <circle cx="240" cy="310" r="6" fill="#83dbc0" />
                    <circle cx="393" cy="118" r="6" fill="#83dbc0" />
                    <circle cx="290" cy="225" r="22" stroke="#c3f0a0" strokeOpacity=".55" />
                    <circle cx="174" cy="148" r="18" stroke="#c3f0a0" strokeOpacity=".35" />
                    <path
                      d="M18 36H78M18 36V76M462 344H402M462 344V384"
                      stroke="#9aceaa"
                      strokeOpacity=".3"
                    />
                  </svg>
                  <span className="ml-node-label ml-node-a">{localize('MARKET DATA')}</span>
                  <span className="ml-node-label ml-node-b">{localize('RISK GATE')}</span>
                  <span className="ml-node-label ml-node-c">{localize('ROUTE ANALYSIS')}</span>
                  <div className="ml-monitor-orb" />
                </div>
                <div className="ml-monitor-footer">
                  <span>{localize('OBSERVATION GRAPH')}</span>
                  <span>{localize('ILLUSTRATION · NOT A LIVE TRADE')}</span>
                </div>
              </div>
              <div className="ml-feed-card">
                <div className="ml-feed-card-header">
                  <div>
                    <span>{localize('01 / MARKET SNAPSHOT')}</span>
                    <strong>{localize('Selected Solana assets')}</strong>
                  </div>
                  <button
                    type="button"
                    onClick={refresh}
                    aria-label={localize('Refresh market observations')}
                    title={localize('Refresh observations')}
                  >
                    <Icon name="refresh" size={16} />
                  </button>
                </div>
                {tokens.length ? (
                  <div className="ml-feed-list">
                    {tokens.slice(0, 3).map((token) => (
                      <div className="ml-feed-row" key={token.mint}>
                        <TokenMark symbol={token.symbol} color={token.color} />
                        <div className="ml-feed-name">
                          <strong>{token.symbol}</strong>
                          <span>{token.name}</span>
                        </div>
                        <div className="ml-feed-values">
                          <strong>{money(token.price)}</strong>
                          <small
                            className={
                              token.change != null && token.change < 0 ? 'negative' : 'positive'
                            }
                          >
                            {pct(token.change)} / 24H
                          </small>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="ml-feed-empty" role="status">
                    <Icon name={loading ? 'refresh' : 'globe'} size={25} />
                    <strong>
                      {loading
                        ? localize('Connecting to live data')
                        : localize('Market feed unavailable')}
                    </strong>
                    <p>
                      {error ??
                        localize('Market observations will appear when the data source responds.')}
                    </p>
                  </div>
                )}
                <div className="ml-feed-card-footer">
                  <span>{localize('Market snapshots are not executable quotes.')}</span>
                  <Link to="/markets">{localize('DETAILS ↗')}</Link>
                </div>
              </div>
            </div>
            <div className="ml-console-bottombar">
              <span>{localize('GSP / SOLANA MAINNET · RESEARCH MODE')}</span>
              <span>
                {updatedAt
                  ? 'UPDATED ' +
                    new Date(updatedAt).toLocaleTimeString('en-GB', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })
                  : localize('AWAITING FEED')}
              </span>
            </div>
          </div>
        </div>
        <div className="site-container ml-hero-meta">
          <span>{localize('MARKETS / ROUTES / RISK')}</span>
          <a href="#market-watch">
            {localize('EXPLORE THE WORKSPACE') + ' '}
            <span aria-hidden="true">↓</span>
          </a>
        </div>
      </section>
      <MarketTicker />
      <div
        className="site-container ml-operation-band"
        aria-label={localize('Explore the Moneyland workflow')}
      >
        <Link to="/markets" className="ml-operation-item">
          <span>{localize('01 / OBSERVE')}</span>
          <strong>{localize('Watch the flow')}</strong>
          <small>{localize('Market prices, liquidity and volume')}</small>
          <span aria-hidden="true">↗</span>
        </Link>
        <Link to="/arbitrage" className="ml-operation-item">
          <span>{localize('02 / EVALUATE')}</span>
          <strong>{localize('Model the route')}</strong>
          <small>{localize('Compare quotes, costs and freshness')}</small>
          <span aria-hidden="true">↗</span>
        </Link>
        <Link to="/security" className="ml-operation-item">
          <span>{localize('03 / UNDERSTAND')}</span>
          <strong>{localize('Protect your decisions')}</strong>
          <small>{localize('Review risks before committing capital')}</small>
          <span aria-hidden="true">↗</span>
        </Link>
      </div>
      <div className="site-container venue-strip">
        <span>
          {localize('Market & quote')}
          <br />
          {localize('sources')}
        </span>
        <div>Raydium</div>
        <div className="venue-orca">orca</div>
        <div>
          Meteora<span className="brand-period">✳</span>
        </div>
        <div className="venue-jupiter">Jupiter</div>
        <a href="/tools#questions" aria-label={localize('Read about data sources')}>
          <Icon name="external" size={18} />
        </a>
      </div>
      <section className="site-section site-container" id="market-watch">
        <div className="workspace-intro">
          <div>
            <span className="eyebrow">{localize('ON THE WEBSITE')}</span>
            <h2>{localize('Your tools. Ready to open.')}</h2>
          </div>
          <Link className="text-link" to="/tools">
            {localize('All website tools')}
          </Link>
        </div>
        <WebsiteTools />
        <div className="section-heading">
          <div>
            <div className="eyebrow">
              <span />
              {' ' + localize('THE MARKET, IN FOCUS')}
            </div>
            <h2>
              {localize('A wider lens.')}
              <br />
              <span className="muted">{localize('A sharper view.')}</span>
            </h2>
          </div>
          <div className="section-heading-aside">
            <p>
              {localize(
                'Follow the assets and liquidity shaping Solana. See current prices, then look closer.',
              )}
            </p>
            <Link className="text-link" to="/markets">
              {localize('Explore all markets') + ' '}
              <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
        <div className="market-preview panel">
          <div className="panel-label">
            <span>
              <Icon name="activity" size={16} />
              {' ' + localize('Market watch')}
            </span>
            <span className="subtle-label">{localize('DEX SCREENER · 30 SEC REFRESH')}</span>
          </div>
          <div className="table-scroll">
            <table className="nova-table">
              <thead>
                <tr>
                  <th>{localize('Asset')}</th>
                  <th>{localize('Price')}</th>
                  <th>{localize('24h change')}</th>
                  <th>{localize('Observed liquidity')}</th>
                  <th>{localize('24h pool volume')}</th>
                  <th>
                    <span className="sr-only">{localize('View')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.slice(0, 4).map((t) => (
                  <tr key={t.mint}>
                    <td>
                      <Link className="asset-cell" to="/markets">
                        <TokenMark symbol={t.symbol} color={t.color} />
                        <span>
                          <strong>{t.name}</strong>
                          <small>{t.symbol}</small>
                        </span>
                      </Link>
                    </td>
                    <td className="number">{money(t.price)}</td>
                    <td
                      className={`number ${t.change != null && t.change < 0 ? 'negative' : 'positive'}`}
                    >
                      {pct(t.change)}
                    </td>
                    <td className="number muted">{money(t.liquidity, true)}</td>
                    <td className="number muted">{money(t.volume, true)}</td>
                    <td>
                      <Link className="table-link" to="/markets" aria-label={`Explore ${t.name}`}>
                        ↗
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!tokens.length && (
              <div className="empty-state">
                <Icon name={loading ? 'refresh' : 'globe'} size={30} />
                <h3>
                  {loading
                    ? localize('Connecting to the market')
                    : localize('Market feed unavailable')}
                </h3>
                <p>
                  {error ??
                    localize('Current prices will appear here as soon as the source responds.')}
                </p>
                <Link className="text-link" to="/markets">
                  {localize('Open markets ↗')}
                </Link>
              </div>
            )}
          </div>
        </div>
        <p className="source-note">
          {localize(
            'Prices reflect selected pools. Observed liquidity and volume cover returned pools, not the entire market.',
          )}
        </p>
      </section>
      <NetworkWinners />
      <section className="toolkit-section">
        <div className="site-container site-section">
          <div className="section-heading">
            <div>
              <div className="eyebrow">
                <span />
                {' ' + localize('GSP EXECUTION STACK')}
              </div>
              <h2>
                {localize('Intelligence first.')}
                <br />
                <span className="muted">{localize('Execution with context.')}</span>
              </h2>
            </div>
            <p className="section-intro">
              {localize(
                'One institutional interface for market discovery, cross-venue route analysis, execution assumptions, and risk-aware trading workflows.',
              )}
            </p>
          </div>
          <div className="feature-grid">
            <Link className="feature-card feature-main" to="/arbitrage">
              <img
                src="/images/gsp-trading-hero.svg"
                alt={localize('Two titanium arcs linked by a bright green stream')}
                width="1536"
                height="1024"
                loading="lazy"
              />
              <div className="feature-top">
                <span className="outline-tag">{localize('01 / ARBITRAGE INTELLIGENCE')}</span>
                <span className="round-arrow">↗</span>
              </div>
              <div className="feature-copy">
                <h3>
                  {localize('A different angle')}
                  <br />
                  {localize('on every route.')}
                </h3>
                <p>
                  {localize(
                    'Compare direct routes across venues. See the return, cost assumptions, and age of every observation.',
                  )}
                </p>
                <span className="text-link">{localize('Enter the terminal ↗')}</span>
              </div>
            </Link>
            <Link className="feature-card feature-markets" to="/markets">
              <div className="feature-top">
                <span className="outline-tag">{localize('02 / MARKET EXPLORER')}</span>
                <span className="round-arrow">↗</span>
              </div>
              <div className="token-orbit" aria-hidden="true">
                <TokenMark symbol="SOL" />
                <TokenMark symbol="JUP" color="#b7f080" />
                <TokenMark symbol="RAY" color="#baa0ff" />
                <TokenMark symbol="WIF" color="#caa779" />
              </div>
              <div className="feature-copy">
                <h3>{localize('Follow the flow.')}</h3>
                <p>
                  {localize('Search assets. Compare liquidity. Find the pools behind the price.')}
                </p>
              </div>
            </Link>
            <Link className="feature-card feature-controls" to="/security">
              <Icon name="shield" size={33} />
              <div>
                <span className="eyebrow">{localize('03 / INFORMED CONTROL')}</span>
                <h3>
                  {localize('Confidence starts')}
                  <br />
                  {localize('with understanding.')}
                </h3>
              </div>
              <span className="round-arrow">↗</span>
            </Link>
          </div>
        </div>
      </section>
      <section className="site-container site-section split-section">
        <div>
          <div className="eyebrow">
            <span />
            {' ' + localize('INSIDE THE TERMINAL')}
          </div>
          <h2>
            {localize('Two venues.')}
            <br />
            <span className="muted">{localize('One informed view.')}</span>
          </h2>
          <p className="large-copy">
            {localize(
              'A spread is only the beginning. GSP TRADING brings both sides of the route, execution-cost assumptions, and quote freshness into the same frame.',
            )}
          </p>
          <div className="check-list">
            <div>
              <Icon name="check" />
              {' ' + localize('Every ordered pair across three venues')}
            </div>
            <div>
              <Icon name="check" />
              {' ' + localize('Minimum quote outputs and adjustable buffers')}
            </div>
            <div>
              <Icon name="check" />
              {' ' + localize('Real observations you can inspect and export')}
            </div>
          </div>
          <Link className="nova-button button-outline" to="/arbitrage">
            {localize('See the live terminal') + ' '}
            <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <div className="route-illustration">
          <div className="panel-label">
            <span>
              <Icon name="scan" size={17} />
              {' ' + localize('A round trip, unpacked')}
            </span>
            <span className="outline-tag">{localize('ILLUSTRATION')}</span>
          </div>
          <div className="route-flow">
            <div className="route-flow-node">
              <TokenMark symbol="SOL" />
              <strong>SOL</strong>
              <small>{localize('Starting asset')}</small>
            </div>
            <div className="route-connector">
              <span>{localize('VENUE A')}</span>
              <i />
              <small>{localize('Buy quote')}</small>
            </div>
            <div className="route-flow-node">
              <TokenMark symbol="USDC" color="#7fa8f2" />
              <strong>USDC</strong>
              <small>{localize('Intermediate asset')}</small>
            </div>
            <div className="route-connector">
              <span>{localize('VENUE B')}</span>
              <i />
              <small>{localize('Sell quote')}</small>
            </div>
            <div className="route-flow-node">
              <TokenMark symbol="SOL" />
              <strong>SOL</strong>
              <small>{localize('Return asset')}</small>
            </div>
          </div>
          <div className="formula">
            <span>{localize('Minimum return')}</span>
            <span>{localize('− Starting amount')}</span>
            <span>{localize('− Cost budget & buffer')}</span>
            <strong>{localize('= Estimated net result')}</strong>
          </div>
          <p className="source-note">
            {localize(
              'Sequential quotes are observations. They do not reserve liquidity or create an atomic transaction.',
            )}
          </p>
        </div>
      </section>
      <section className="security-story site-container">
        <div className="security-art">
          <img
            src="/images/gsp-risk-grid.svg"
            alt={localize('GSP TRADING risk, simulation, and execution-gate visualization')}
            width="1536"
            height="1024"
            loading="lazy"
          />
        </div>
        <div className="security-copy">
          <div className="eyebrow">
            <span />
            {' ' + localize('CLARITY BEFORE EXECUTION')}
          </div>
          <h2>
            {localize('Your decisions.')}
            <br />
            <span className="muted">{localize('Made with context.')}</span>
          </h2>
          <p>
            {localize(
              'Understand the custody model, market risks, and limits of quoted returns before you commit capital.',
            )}
          </p>
          <Link className="text-link" to="/security">
            {localize('Explore risk & security ↗')}
          </Link>
        </div>
      </section>
      <section className="site-container closing-cta">
        <div className="eyebrow">
          <span />
          {' ' + localize('GSP TRADING · BUILT FOR EXECUTION')}
        </div>
        <h2>
          {localize('The whole picture.')}
          <br />
          <span>{localize('Within reach.')}</span>
        </h2>
        <p>
          {localize(
            'Open the market, inspect the route, and act only when the numbers justify it.',
          )}
        </p>
        <div className="button-row">
          <Link className="nova-button" to="/arbitrage">
            {localize('Open the terminal') + ' '}
            <Icon name="external" size={17} />
          </Link>
          <Link className="nova-button button-ghost" to="/wallet">
            {localize('Connect wallet')}
          </Link>
        </div>
        <span className="cta-orbit" aria-hidden="true">
          ◎
        </span>
      </section>
      <section className="site-container telegram-entry">
        <div className="telegram-entry-title">
          <Icon name="telegram" size={32} />
          <div>
            <span className="eyebrow">{localize('IN TELEGRAM')}</span>
            <h2>{localize('GSP TRADING bot')}</h2>
            <p>
              {localize(
                'Wallets, snipe configs, open positions, and packages — in your Telegram account.',
              )}
            </p>
          </div>
        </div>
        <Link className="nova-button button-outline" to="/telegram">
          {localize('Explore Telegram bot')}
        </Link>
      </section>
    </>
  );
}
