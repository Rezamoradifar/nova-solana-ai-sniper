import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, PageHeading } from '../components/public/PublicLayout.js';
import { BOT_URL, PUBLIC_API_BASE } from '../lib/publicMarket.js';
import { WebsiteTools } from '../components/public/WebsiteTools.js';

const QUESTIONS = [
  [
    'Does the public terminal execute trades?',
    'No. The public terminal requests market quotes, calculates estimated returns, and lets you inspect and export observations. Wallet connection is optional and handled in its own section. The terminal does not sign transactions or submit trades.',
  ],
  [
    'Does a positive estimate guarantee a profit?',
    'No. Quotes arrive at different times and do not reserve liquidity. Prices, network costs, slippage, token behavior, and failed transactions can change the result. A positive quote observation is not a realized return.',
  ],
  [
    'What is the difference between the terminal and the Telegram app?',
    'The website provides public market discovery and read-only route analysis. The separate GSP TRADEING Telegram app provides account, plan, wallet, and trading workflows. Its availability and enabled features depend on the deployed service and your plan.',
  ],
  [
    'Where does the data come from?',
    'Market prices and pool information come from DEX Screener. The terminal requests direct Solana swap quotes from Jupiter for selected venues. Source availability and rate limits affect coverage.',
  ],
  [
    'Why might a route be missing or stale?',
    'A venue may not have a direct pool for the selected asset or amount. The provider may also reject a request or apply rate limits. Old observations remain visibly marked as stale until a new scan replaces them.',
  ],
  [
    'How do I get started?',
    'Open Markets to explore the selected assets, then use the arbitrage terminal to compare direct routes. For account-based GSP TRADEING features, open the linked Telegram app and confirm the available plans, custody model, and settings before funding an account.',
  ],
] as const;

export function PublicPlatform() {
  return (
    <div className="site-container interior-page">
      <PageHeading
        eyebrow="WEBSITE TOOLS"
        title="Your Solana workspace."
        text="Explore live markets, compare cross-DEX routes, and connect your own wallet. Choose a tool to get started."
      />
      <WebsiteTools />
      <div className="platform-banner">
        <img
          src="/images/nova-execution.webp"
          alt="Two flowing metallic arcs connected by green light"
          width="1536"
          height="1024"
        />
        <div>
          <span className="eyebrow">CONNECTED PERSPECTIVE</span>
          <h2>
            Follow the market.
            <br />
            Understand the route.
          </h2>
          <Link className="nova-button" to="/arbitrage">
            Explore the terminal ↗
          </Link>
        </div>
      </div>
      <section className="site-section">
        <div className="section-heading">
          <div>
            <div className="eyebrow">
              <span /> FROM SIGNAL TO UNDERSTANDING
            </div>
            <h2>A more considered workflow.</h2>
          </div>
        </div>
        <div className="workflow-grid">
          {[
            {
              n: '01',
              icon: 'globe' as const,
              title: 'Discover',
              text: 'Explore current prices, observed liquidity, and pool volume. Follow an asset into the venues behind its price.',
              link: '/markets',
              action: 'Explore markets',
            },
            {
              n: '02',
              icon: 'scan' as const,
              title: 'Evaluate',
              text: 'Compare both legs of a cross-venue route. Adjust the amount, cost budget, and buffer to inspect the resulting estimate.',
              link: '/arbitrage',
              action: 'Compare routes',
            },
            {
              n: '03',
              icon: 'wallet' as const,
              title: 'Connect',
              text: 'Choose a detected Solana wallet and approve access to your public address. View your connection and disconnect at any time.',
              link: '/wallet',
              action: 'Open wallet connection',
            },
            {
              n: '04',
              icon: 'shield' as const,
              title: 'Understand',
              text: 'Review custody, transaction risk, and the limits of quoted returns. Keep the distinction between an observation and a trade clear.',
              link: '/security',
              action: 'Read risk & security',
            },
          ].map((w) => (
            <article className="workflow-card" key={w.n}>
              <div>
                <Icon name={w.icon} size={26} />
                <span>{w.n}</span>
              </div>
              <h3>{w.title}</h3>
              <p>{w.text}</p>
              <Link className="text-link" to={w.link}>
                {w.action} ↗
              </Link>
            </article>
          ))}
        </div>
      </section>
      <section className="faq-section" id="questions">
        <div>
          <div className="eyebrow">
            <span /> THE DETAILS MATTER
          </div>
          <h2>
            Good questions.
            <br />
            <span className="muted">Clear answers.</span>
          </h2>
          <p>Know what you are looking at, and what happens next.</p>
        </div>
        <div className="faq-list">
          {QUESTIONS.map(([q, a]) => (
            <details key={q}>
              <summary>
                {q}
                <Icon name="chevron" size={18} />
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
      <div className="inline-cta">
        <div>
          <span className="eyebrow">FIND YOUR PERSPECTIVE</span>
          <h2>The next view is yours.</h2>
        </div>
        <Link className="nova-button" to="/arbitrage">
          Open the terminal ↗
        </Link>
      </div>
    </div>
  );
}

export function PublicSecurity() {
  return (
    <div className="site-container interior-page">
      <PageHeading
        eyebrow="RISK & SECURITY"
        title="Know what you control."
        text="Clear boundaries, transparent assumptions, and an honest view of how the system works."
      />
      <div className="security-banner">
        <img
          src="/images/nova-security.webp"
          alt="Sculptural titanium enclosure with a thin luminous green seam"
          width="1536"
          height="1024"
        />
        <div>
          <Icon name="shield" size={32} />
          <h2>
            A quote is a view.
            <br />A trade is a commitment.
          </h2>
          <p>
            The public terminal is an observation tool. Trading features live in a separate
            account-based service.
          </p>
        </div>
      </div>
      <section className="security-grid">
        {[
          [
            '01',
            'Custody, made explicit',
            'Markets and quote analysis work without a wallet. The optional website wallet connection reads your approved public address; keys stay in your wallet. The separate GSP TRADEING bot supports server-managed wallets with encrypted key storage. That is a custodial model: you depend on the operator and its infrastructure to safeguard those keys.',
          ],
          [
            '02',
            'Quotes have limits',
            'A route combines quotes obtained sequentially from different venues. These observations do not lock prices, reserve liquidity, or prove that both legs can execute together. Market movement can turn a positive estimate into a loss.',
          ],
          [
            '03',
            'Costs are assumptions',
            'The terminal shows your network-cost budget and an additional safety buffer. These are adjustable estimates. Actual transaction fees, priority fees, tips, account creation, transfer costs, and failures can differ.',
          ],
          [
            '04',
            'Freshness stays visible',
            'Each route displays its age using the earlier quote. Old observations are marked stale, and a failed feed shows a connection state. No historical profits or completed trades are inferred from quote data.',
          ],
        ].map(([n, title, text]) => (
          <article className="security-card" key={n}>
            <span className="card-number">{n}</span>
            <h3>{title}</h3>
            <p>{text}</p>
          </article>
        ))}
      </section>
      <section className="risk-panel">
        <div>
          <div className="eyebrow">
            <span /> BEFORE COMMITTING CAPITAL
          </div>
          <h2>
            Give the details
            <br />
            your attention.
          </h2>
        </div>
        <div className="risk-guidelines">
          <p>
            <span>01</span> Verify the app, network, and token address through trusted sources.
          </p>
          <p>
            <span>02</span> Understand custody and withdrawal access before funding an account.
          </p>
          <p>
            <span>03</span> Review position limits, stop settings, and the impact of failed
            transactions.
          </p>
          <p>
            <span>04</span> Treat quotes as time-sensitive estimates. Digital asset trading can
            result in loss of capital.
          </p>
          <a
            className="text-link"
            href="https://github.com/Rezamoradifar/nova-solana-ai-sniper/blob/main/SECURITY.md"
            target="_blank"
            rel="noreferrer"
          >
            Source security policy ↗
          </a>
        </div>
      </section>
      <div className="inline-cta">
        <div>
          <span className="eyebrow">EXPLORE WITH CONTEXT</span>
          <h2>See the numbers. Know their limits.</h2>
        </div>
        <Link className="nova-button" to="/arbitrage">
          Explore the terminal ↗
        </Link>
      </div>
    </div>
  );
}

interface Plan {
  key: string;
  name: string;
  priceSol: number;
  durationDays: number;
  feeBps: number;
  maxBuySol: number;
  maxOpenPositions: number;
  features: Record<string, unknown>;
}
const TIERS = [
  {
    key: 'FREE',
    name: 'Free',
    label: 'A place to begin.',
    description: 'Explore GSP and review the starting account features.',
  },
  {
    key: 'PRO',
    name: 'Pro',
    label: 'Room to go further.',
    description: 'Review expanded access and account limits in the app.',
  },
  {
    key: 'ELITE',
    name: 'Elite',
    label: 'A broader perspective.',
    description: 'Explore the highest listed tier and its available controls.',
  },
];
export function PublicPricing() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const c = new AbortController();
    fetch(`${PUBLIC_API_BASE}/public/plans`, {
      signal: AbortSignal.any([c.signal, AbortSignal.timeout(8000)]),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error('Plans unavailable');
        return r.json() as Promise<unknown>;
      })
      .then((raw) => {
        const list = Array.isArray(raw)
          ? raw
          : typeof raw === 'object' && raw !== null && 'plans' in raw
            ? (raw as { plans: unknown }).plans
            : [];
        if (Array.isArray(list))
          setPlans(
            list.filter(
              (p): p is Plan =>
                p &&
                typeof p.key === 'string' &&
                typeof p.name === 'string' &&
                Number.isFinite(p.priceSol) &&
                p.priceSol >= 0 &&
                Number.isFinite(p.durationDays) &&
                p.durationDays > 0,
            ),
          );
      })
      .catch(() => {})
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, []);
  return (
    <div className="site-container interior-page">
      <PageHeading
        eyebrow="TELEGRAM BOT PACKAGES"
        title="Your bot. Your package."
        text="Start free — upgrade in Packages for a lower fee and higher limits. Explore current options in the GSP TRADEING Telegram app."
      />
      <div className="access-banner">
        <div>
          <Icon name="globe" size={24} />
          <span>
            <strong>Explore before you commit.</strong>
            <small>The public markets and quote terminal require no wallet or account.</small>
          </span>
        </div>
        <Link className="text-link" to="/arbitrage">
          Open terminal ↗
        </Link>
      </div>
      <div className="pricing-grid">
        {TIERS.map((tier, i) => {
          const plan = plans.find((p) => p.key.toUpperCase() === tier.key);
          return (
            <article className={`pricing-card ${i === 1 ? 'featured' : ''}`} key={tier.key}>
              <div className="plan-top">
                <span>{tier.name}</span>
                {i === 1 && <span className="outline-tag">MORE POSSIBILITY</span>}
              </div>
              <h2>{tier.label}</h2>
              <p>{tier.description}</p>
              <div className="plan-price">
                {plan ? (
                  <>
                    <strong>
                      {plan.priceSol} <small>SOL</small>
                    </strong>
                    <span>per {plan.durationDays} days</span>
                  </>
                ) : (
                  <>
                    <strong>{loading ? 'Loading…' : 'View in app'}</strong>
                    <span>Confirm current price and terms</span>
                  </>
                )}
              </div>
              <a
                className={`nova-button ${i === 1 ? '' : 'button-outline'}`}
                href={BOT_URL}
                target="_blank"
                rel="noreferrer"
              >
                Explore {tier.name} <span aria-hidden="true">↗</span>
              </a>
              <div className="plan-details">
                {plan ? (
                  <>
                    <p>
                      <Icon name="check" size={16} />
                      {Number.isFinite(plan.maxOpenPositions)
                        ? `${plan.maxOpenPositions} maximum open positions`
                        : 'Position limits shown in app'}
                    </p>
                    <p>
                      <Icon name="check" size={16} />
                      {Number.isFinite(plan.maxBuySol)
                        ? `${plan.maxBuySol} SOL maximum buy`
                        : 'Buy limits shown in app'}
                    </p>
                    <p>
                      <Icon name="check" size={16} />
                      {Number.isFinite(plan.feeBps)
                        ? `${plan.feeBps / 100}% listed performance fee`
                        : 'Performance fee shown in app'}
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      <Icon name="check" size={16} />
                      Review current feature access
                    </p>
                    <p>
                      <Icon name="check" size={16} />
                      Check position and buy limits
                    </p>
                    <p>
                      <Icon name="check" size={16} />
                      Confirm fees before subscribing
                    </p>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <p className="pricing-note">
        {plans.length
          ? 'Plan details are supplied by the connected GSP TRADEING service. Confirm the final terms in the app.'
          : 'The pricing service is not connected in this website session. Current prices are not being estimated or substituted.'}{' '}
        Network costs and trading risk are separate from plan access.
      </p>
      <section className="faq-section pricing-faq">
        <div>
          <div className="eyebrow">
            <span /> BEFORE YOU START
          </div>
          <h2>A little more clarity.</h2>
        </div>
        <div className="faq-list">
          <details>
            <summary>
              Can I explore without paying?
              <Icon name="chevron" size={18} />
            </summary>
            <p>
              Yes. Public market discovery and the read-only arbitrage terminal are accessible here
              without an account. Quote availability depends on the external data source.
            </p>
          </details>
          <details>
            <summary>
              Does a plan include guaranteed returns?
              <Icon name="chevron" size={18} />
            </summary>
            <p>
              No. Plan access does not guarantee execution, profitable routes, or trading returns.
              Review the risk and custody information before using account-based features.
            </p>
          </details>
          <details>
            <summary>
              Where do I manage my subscription?
              <Icon name="chevron" size={18} />
            </summary>
            <p>
              Open the linked GSP TRADEING Telegram app to review the available account and plan
              workflows. Confirm the operator, current pricing, and payment instructions inside the
              app.
            </p>
          </details>
        </div>
      </section>
    </div>
  );
}
