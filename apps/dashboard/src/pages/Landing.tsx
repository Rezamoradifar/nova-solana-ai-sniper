import { Link } from 'react-router-dom';
import { Icon, MarketTicker, TokenMark, useMarkets } from '../components/public/PublicLayout.js';
import { money, pct } from '../lib/publicMarket.js';
import { WebsiteTools } from '../components/public/WebsiteTools.js';
import { NetworkWinners } from '../components/public/NetworkWinners.js';

export default function Landing() {
  const { tokens, loading, error } = useMarkets();
  return (
    <>
      <section className="nova-hero">
        <img
          className="hero-art"
          src="/images/gsp-trading-hero.svg"
          alt="GSP TRADING Solana execution matrix with market routes and smart-wallet nodes"
          width="1536"
          height="1024"
          fetchPriority="high"
        />
        <div className="hero-shade" />
        <div className="site-container hero-content">
          <div className="hero-brand-lockup" aria-label="GSP TRADING platform">
            <span>GSP</span>
            <strong>TRADING</strong>
            <i>GLOBAL SOLANA EXECUTION PLATFORM</i>
          </div>
          <div className="eyebrow">
            <span /> INSTITUTIONAL MARKET INTELLIGENCE
          </div>
          <h1>
            Trade the spread.
            <br />
            <span>Control the execution.</span>
          </h1>
          <p>
            Multi-venue Solana intelligence for market discovery, arbitrage analysis, and
            simulation-gated execution workflows.
          </p>
          <div className="button-row">
            <Link className="nova-button" to="/arbitrage">
              Open arbitrage terminal <Icon name="external" size={17} />
            </Link>
            <Link className="nova-button button-ghost" to="/tools">
              Explore GSP TRADING
            </Link>
          </div>
          <div className="hero-system-strip" aria-label="Platform capabilities">
            <div>
              <span>NETWORK</span>
              <strong>Solana Mainnet</strong>
            </div>
            <div>
              <span>ROUTING</span>
              <strong>Multi-venue</strong>
            </div>
            <div>
              <span>RISK LAYER</span>
              <strong>Simulation gated</strong>
            </div>
            <div>
              <span>PLATFORM</span>
              <strong>GSP TRADING</strong>
            </div>
          </div>
        </div>
        <div className="site-container hero-bottom">
          <span>01 / THE NEXT PERSPECTIVE</span>
          <a href="#market-watch">
            SCROLL TO EXPLORE <span aria-hidden="true">↓</span>
          </a>
        </div>
      </section>
      <MarketTicker />
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
