import { Link } from 'react-router-dom';
import { Icon, MarketTicker, TokenMark, useMarkets } from '../components/public/PublicLayout.js';
import { money, pct } from '../lib/publicMarket.js';
import { WebsiteTools } from '../components/public/WebsiteTools.js';
import { NetworkWinners } from '../components/public/NetworkWinners.js';

export default function Landing() {
  const { tokens, loading, error, updatedAt, refresh } = useMarkets();
  return (
    <>
      <section className="ml-hero" aria-labelledby="ml-hero-title">
        <div className="ml-hero-grid-overlay" aria-hidden="true" />
        <div className="site-container ml-hero-grid">
          <div className="ml-hero-copy">
            <div className="ml-hero-chip">
              <span className="ml-hero-signal" />
              SOLANA OPERATIONS INTELLIGENCE
              <span className="ml-chip-divider" />
              01 / MONEYLAND
            </div>
            <p className="ml-hero-overline">GSP TRADING / OBSERVE · EVALUATE · ACT</p>
            <h1 id="ml-hero-title">
              Read the market.
              <br />
              <span>Own the next move.</span>
            </h1>
            <p className="ml-hero-lead">
              Your command center for Solana markets, cross-venue route analysis, and informed
              trading decisions. See the data, understand the assumptions, then decide what
              happens next.
            </p>
            <div className="button-row ml-hero-actions">
              <Link className="nova-button ml-primary-action" to="/arbitrage">
                Explore the terminal <Icon name="external" size={16} />
              </Link>
              <Link className="nova-button button-outline ml-secondary-action" to="/markets">
                View live markets <span aria-hidden="true">↗</span>
              </Link>
            </div>
            <div className="ml-hero-footnotes">
              <span><Icon name="check" size={15} /> Public market research</span>
              <span><Icon name="check" size={15} /> Transparent route assumptions</span>
              <span><Icon name="check" size={15} /> Risk-aware tools</span>
            </div>
          </div>
          <div className="ml-console" aria-label="GSP trading observation console">
            <div className="ml-console-topbar">
              <div className="ml-console-identity">
                <span className="ml-console-emblem" aria-hidden="true">◈</span>
                <span><strong>GSP / MARKET MIRROR</strong><small>READ-ONLY OBSERVATION LAYER</small></span>
              </div>
              <span
                className={tokens.length ? 'ml-feed-status ml-feed-ready' : error ? 'ml-feed-status ml-feed-error' : 'ml-feed-status ml-feed-wait'}
              >
                <span className="ml-status-signal" />
                {tokens.length ? 'FEED CONNECTED' : error ? 'SOURCE UNAVAILABLE' : 'CONNECTING'}
              </span>
            </div>
            <div className="ml-console-body">
              <div className="ml-monitor">
                <div className="ml-monitor-header">
                  <span>NETWORK TOPOLOGY</span>
                  <span>VIEW · SOLANA</span>
                </div>
                <div className="ml-monitor-art" aria-hidden="true">
                  <svg viewBox="0 0 480 420" fill="none" preserveAspectRatio="xMidYMid meet">
                    <defs>
                      <pattern id="ml-grid" width="28" height="28" patternUnits="userSpaceOnUse">
                        <path d="M28 0H0V28" stroke="#5a8371" strokeOpacity=".12" strokeWidth="1" />
                      </pattern>
                      <linearGradient id="ml-arc" x1="54" y1="190" x2="442" y2="230" gradientUnits="userSpaceOnUse">
                        <stop stopColor="#8be5b8" stopOpacity=".16" />
                        <stop offset=".5" stopColor="#c5f5a2" />
                        <stop offset="1" stopColor="#6de0cf" stopOpacity=".25" />
                      </linearGradient>
                    </defs>
                    <rect width="480" height="420" fill="url(#ml-grid)" />
                    <circle cx="240" cy="212" r="145" stroke="#72958a" strokeOpacity=".25" strokeDasharray="3 8" />
                    <circle cx="240" cy="212" r="103" stroke="#a8f5b8" strokeOpacity=".16" />
                    <circle cx="240" cy="212" r="60" stroke="#a8f5b8" strokeOpacity=".18" strokeDasharray="4 7" />
                    <path d="M76 263L174 148L290 225L393 118" stroke="url(#ml-arc)" strokeWidth="2" />
                    <path d="M76 263L240 310L393 118" stroke="#79c0bc" strokeOpacity=".38" strokeDasharray="5 9" />
                    <path d="M174 148L240 310L290 225" stroke="#7fd9a8" strokeOpacity=".38" strokeDasharray="4 8" />
                    <circle cx="76" cy="263" r="6" fill="#83dbc0" />
                    <circle cx="174" cy="148" r="8" fill="#c3f0a0" />
                    <circle cx="290" cy="225" r="9" fill="#c3f0a0" />
                    <circle cx="240" cy="310" r="6" fill="#83dbc0" />
                    <circle cx="393" cy="118" r="6" fill="#83dbc0" />
                    <circle cx="290" cy="225" r="22" stroke="#c3f0a0" strokeOpacity=".55" />
                    <circle cx="174" cy="148" r="18" stroke="#c3f0a0" strokeOpacity=".35" />
                    <path d="M18 36H78M18 36V76M462 344H402M462 344V384" stroke="#9aceaa" strokeOpacity=".3" />
                  </svg>
                  <span className="ml-node-label ml-node-a">MARKET DATA</span>
                  <span className="ml-node-label ml-node-b">RISK GATE</span>
                  <span className="ml-node-label ml-node-c">ROUTE ANALYSIS</span>
                  <div className="ml-monitor-orb" />
                </div>
                <div className="ml-monitor-footer">
                  <span>OBSERVATION GRAPH</span>
                  <span>ILLUSTRATION · NOT A LIVE TRADE</span>
                </div>
              </div>
              <div className="ml-feed-card">
                <div className="ml-feed-card-header">
                  <div>
                    <span>01 / MARKET SNAPSHOT</span>
                    <strong>Selected Solana assets</strong>
                  </div>
                  <button type="button" onClick={refresh} aria-label="Refresh market observations" title="Refresh observations">
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
                          <small className={token.change != null && token.change < 0 ? 'negative' : 'positive'}>
                            {pct(token.change)} / 24H
                          </small>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="ml-feed-empty" role="status">
                    <Icon name={loading ? 'refresh' : 'globe'} size={25} />
                    <strong>{loading ? 'Connecting to live data' : 'Market feed unavailable'}</strong>
                    <p>{error ?? 'Market observations will appear when the data source responds.'}</p>
                  </div>
                )}
                <div className="ml-feed-card-footer">
                  <span>Market snapshots are not executable quotes.</span>
                  <Link to="/markets">DETAILS ↗</Link>
                </div>
              </div>
            </div>
            <div className="ml-console-bottombar">
              <span>GSP / SOLANA MAINNET · RESEARCH MODE</span>
              <span>{updatedAt ? 'UPDATED ' + new Date(updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'AWAITING FEED'}</span>
            </div>
          </div>
        </div>
        <div className="site-container ml-hero-meta">
          <span>MARKETS / ROUTES / RISK</span>
          <a href="#market-watch">EXPLORE THE WORKSPACE <span aria-hidden="true">↓</span></a>
        </div>
      </section>
      <MarketTicker />
      <div className="site-container ml-operation-band" aria-label="Explore the Moneyland workflow">
        <Link to="/markets" className="ml-operation-item">
          <span>01 / OBSERVE</span>
          <strong>Watch the flow</strong>
          <small>Market prices, liquidity and volume</small>
          <span aria-hidden="true">↗</span>
        </Link>
        <Link to="/arbitrage" className="ml-operation-item">
          <span>02 / EVALUATE</span>
          <strong>Model the route</strong>
          <small>Compare quotes, costs and freshness</small>
          <span aria-hidden="true">↗</span>
        </Link>
        <Link to="/security" className="ml-operation-item">
          <span>03 / UNDERSTAND</span>
          <strong>Protect your decisions</strong>
          <small>Review risks before committing capital</small>
          <span aria-hidden="true">↗</span>
        </Link>
      </div>
      <div className="site-container venue-strip">
        <span>
          Market & quote
          <br />
          sources
        </span>
        <div>Raydium</div>
        <div className="venue-orca">orca</div>
        <div>
          Meteora<span className="brand-period">✳</span>
        </div>
        <div className="venue-jupiter">Jupiter</div>
        <a href="/tools#questions" aria-label="Read about data sources">
          <Icon name="external" size={18} />
        </a>
      </div>
      <section className="site-section site-container" id="market-watch">
        <div className="workspace-intro">
          <div>
            <span className="eyebrow">ON THE WEBSITE</span>
            <h2>Your tools. Ready to open.</h2>
          </div>
          <Link className="text-link" to="/tools">
            All website tools
          </Link>
        </div>
        <WebsiteTools />
        <div className="section-heading">
          <div>
            <div className="eyebrow">
              <span /> THE MARKET, IN FOCUS
            </div>
            <h2>
              A wider lens.
              <br />
              <span className="muted">A sharper view.</span>
            </h2>
          </div>
          <div className="section-heading-aside">
            <p>
              Follow the assets and liquidity shaping Solana. See current prices, then look closer.
            </p>
            <Link className="text-link" to="/markets">
              Explore all markets <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
        <div className="market-preview panel">
          <div className="panel-label">
            <span>
              <Icon name="activity" size={16} /> Market watch
            </span>
            <span className="subtle-label">DEX SCREENER · 30 SEC REFRESH</span>
          </div>
          <div className="table-scroll">
            <table className="nova-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Price</th>
                  <th>24h change</th>
                  <th>Observed liquidity</th>
                  <th>24h pool volume</th>
                  <th>
                    <span className="sr-only">View</span>
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
                <h3>{loading ? 'Connecting to the market' : 'Market feed unavailable'}</h3>
                <p>{error ?? 'Current prices will appear here as soon as the source responds.'}</p>
                <Link className="text-link" to="/markets">
                  Open markets ↗
                </Link>
              </div>
            )}
          </div>
        </div>
        <p className="source-note">
          Prices reflect selected pools. Observed liquidity and volume cover returned pools, not the
          entire market.
        </p>
      </section>
      <NetworkWinners />
      <section className="toolkit-section">
        <div className="site-container site-section">
          <div className="section-heading">
            <div>
              <div className="eyebrow">
                <span /> GSP EXECUTION STACK
              </div>
              <h2>
                Intelligence first.
                <br />
                <span className="muted">Execution with context.</span>
              </h2>
            </div>
            <p className="section-intro">
              One institutional interface for market discovery, cross-venue route analysis,
              execution assumptions, and risk-aware trading workflows.
            </p>
          </div>
          <div className="feature-grid">
            <Link className="feature-card feature-main" to="/arbitrage">
              <img
                src="/images/gsp-trading-hero.svg"
                alt="Two titanium arcs linked by a bright green stream"
                width="1536"
                height="1024"
                loading="lazy"
              />
              <div className="feature-top">
                <span className="outline-tag">01 / ARBITRAGE INTELLIGENCE</span>
                <span className="round-arrow">↗</span>
              </div>
              <div className="feature-copy">
                <h3>
                  A different angle
                  <br />
                  on every route.
                </h3>
                <p>
                  Compare direct routes across venues. See the return, cost assumptions, and age of
                  every observation.
                </p>
                <span className="text-link">Enter the terminal ↗</span>
              </div>
            </Link>
            <Link className="feature-card feature-markets" to="/markets">
              <div className="feature-top">
                <span className="outline-tag">02 / MARKET EXPLORER</span>
                <span className="round-arrow">↗</span>
              </div>
              <div className="token-orbit" aria-hidden="true">
                <TokenMark symbol="SOL" />
                <TokenMark symbol="JUP" color="#b7f080" />
                <TokenMark symbol="RAY" color="#baa0ff" />
                <TokenMark symbol="WIF" color="#caa779" />
              </div>
              <div className="feature-copy">
                <h3>Follow the flow.</h3>
                <p>Search assets. Compare liquidity. Find the pools behind the price.</p>
              </div>
            </Link>
            <Link className="feature-card feature-controls" to="/security">
              <Icon name="shield" size={33} />
              <div>
                <span className="eyebrow">03 / INFORMED CONTROL</span>
                <h3>
                  Confidence starts
                  <br />
                  with understanding.
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
            <span /> INSIDE THE TERMINAL
          </div>
          <h2>
            Two venues.
            <br />
            <span className="muted">One informed view.</span>
          </h2>
          <p className="large-copy">
            A spread is only the beginning. GSP TRADING brings both sides of the route,
            execution-cost assumptions, and quote freshness into the same frame.
          </p>
          <div className="check-list">
            <div>
              <Icon name="check" /> Every ordered pair across three venues
            </div>
            <div>
              <Icon name="check" /> Minimum quote outputs and adjustable buffers
            </div>
            <div>
              <Icon name="check" /> Real observations you can inspect and export
            </div>
          </div>
          <Link className="nova-button button-outline" to="/arbitrage">
            See the live terminal <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <div className="route-illustration">
          <div className="panel-label">
            <span>
              <Icon name="scan" size={17} /> A round trip, unpacked
            </span>
            <span className="outline-tag">ILLUSTRATION</span>
          </div>
          <div className="route-flow">
            <div className="route-flow-node">
              <TokenMark symbol="SOL" />
              <strong>SOL</strong>
              <small>Starting asset</small>
            </div>
            <div className="route-connector">
              <span>VENUE A</span>
              <i />
              <small>Buy quote</small>
            </div>
            <div className="route-flow-node">
              <TokenMark symbol="USDC" color="#7fa8f2" />
              <strong>USDC</strong>
              <small>Intermediate asset</small>
            </div>
            <div className="route-connector">
              <span>VENUE B</span>
              <i />
              <small>Sell quote</small>
            </div>
            <div className="route-flow-node">
              <TokenMark symbol="SOL" />
              <strong>SOL</strong>
              <small>Return asset</small>
            </div>
          </div>
          <div className="formula">
            <span>Minimum return</span>
            <span>− Starting amount</span>
            <span>− Cost budget & buffer</span>
            <strong>= Estimated net result</strong>
          </div>
          <p className="source-note">
            Sequential quotes are observations. They do not reserve liquidity or create an atomic
            transaction.
          </p>
        </div>
      </section>
      <section className="security-story site-container">
        <div className="security-art">
          <img
            src="/images/gsp-risk-grid.svg"
            alt="GSP TRADING risk, simulation, and execution-gate visualization"
            width="1536"
            height="1024"
            loading="lazy"
          />
        </div>
        <div className="security-copy">
          <div className="eyebrow">
            <span /> CLARITY BEFORE EXECUTION
          </div>
          <h2>
            Your decisions.
            <br />
            <span className="muted">Made with context.</span>
          </h2>
          <p>
            Understand the custody model, market risks, and limits of quoted returns before you
            commit capital.
          </p>
          <Link className="text-link" to="/security">
            Explore risk & security ↗
          </Link>
        </div>
      </section>
      <section className="site-container closing-cta">
        <div className="eyebrow">
          <span /> GSP TRADING · BUILT FOR EXECUTION
        </div>
        <h2>
          The whole picture.
          <br />
          <span>Within reach.</span>
        </h2>
        <p>Open the market, inspect the route, and act only when the numbers justify it.</p>
        <div className="button-row">
          <Link className="nova-button" to="/arbitrage">
            Open the terminal <Icon name="external" size={17} />
          </Link>
          <Link className="nova-button button-ghost" to="/wallet">
            Connect wallet
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
            <span className="eyebrow">IN TELEGRAM</span>
            <h2>GSP TRADING bot</h2>
            <p>Wallets, snipe configs, open positions, and packages — in your Telegram account.</p>
          </div>
        </div>
        <Link className="nova-button button-outline" to="/telegram">
          Explore Telegram bot
        </Link>
      </section>
    </>
  );
}
