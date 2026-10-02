import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import '../landing.css';

const BOT_URL = import.meta.env.VITE_BOT_URL ?? 'https://t.me/GSPBankSniperBot';

const T = {
  en: {
    nav: {
      features: 'Features',
      how: 'How it works',
      network: 'Network trades',
      arb: 'Arbitrage',
      fees: 'Fees',
      faq: 'FAQ',
      dashboard: 'Dashboard',
      start: 'Start on Telegram',
    },
    badge: 'Smart Solana trading bot',
    heroTitle: ['Automated memecoin trading,', 'with a security gate and a real stop-loss'],
    heroSub:
      'GSP Bank Sniper spots new tokens within seconds, checks their safety before buying, and protects your capital with automatic take-profit, stop-loss and trailing stops. All inside Telegram.',
    heroCta: 'Start free on Telegram',
    heroCta2: 'Open dashboard',
    heroNote: 'No install · Encrypted wallet · Risk-free paper mode',
    stats: [
      ['5', 'DEXes monitored live'],
      ['5s', 'price & stop-loss checks'],
      ['10+', 'safety checks before a buy'],
      ['24/7', 'running on our servers'],
    ],
    featuresTitle: 'Everything a Solana trader needs',
    features: [
      [
        '⚡',
        'Real-time launch detection',
        'pump.fun, PumpSwap, Raydium, Orca and Meteora are watched live; new tokens are found within seconds.',
      ],
      [
        '🛡️',
        'Security gate',
        'Honeypots, live mint/freeze authority, holder concentration and thin liquidity are rejected before any buy.',
      ],
      [
        '🎯',
        'Entry confirmation',
        'Waits a few minutes before buying and skips tokens whose price or liquidity has collapsed.',
      ],
      [
        '📉',
        'Real-value stop-loss',
        'Stops trigger on the real sellable quote, not a lagging price feed.',
      ],
      [
        '📈',
        'Staged exits',
        'Sells half at the first target, moves the stop to breakeven and trails the rest.',
      ],
      [
        '🚀',
        'Fast execution',
        'Every order goes to several RPCs and Jito at once so it lands sooner.',
      ],
      [
        '🔐',
        'Wallet security',
        'Keys are stored encrypted. A kill switch and daily loss cap are always on.',
      ],
      [
        '📱',
        'Telegram Mini App',
        'Positions, PnL, settings and performance reports in a full app inside Telegram.',
      ],
    ],
    howTitle: 'From detection to exit, in four steps',
    how: [
      ['Detect', 'Every new token or pool on Solana’s five main DEXes is found within seconds.'],
      [
        'Analyze',
        'Contract safety, liquidity, holders, volume and buy/sell ratio are checked and scored.',
      ],
      ['Buy', 'Only if every filter passes, with the amount and risk you configured.'],
      [
        'Manage & sell',
        'Positions are watched continuously and closed by take-profit, stop-loss or time limit.',
      ],
    ],
    cardCaption: 'Every trade is reported in Telegram with its own card and transaction links',
    networkTitle: 'Real network trades, verifiable on Solscan',
    networkSub:
      'The bot tracks active wallets across the network and publishes their best completed trades. Profit comes from the wallet’s real SOL balance change, and every post links the wallet, the buy and the sell transaction.',
    networkPoints: [
      'Only fully completed, verified buy + sell pairs',
      'Direct Solscan link for every transaction',
      'Clearly labelled: another wallet, not a bot trade',
    ],
    arbTitle: 'DEX-to-DEX arbitrage',
    arbSub:
      'The arbitrage module scans price gaps for the same token across Solana DEXes with a SOL → token → SOL round trip, and computes profit after network fees, tips and slippage.',
    arbPoints: [
      'Continuous scan of liquid pairs',
      'Net profit after every cost',
      'Runs in paper mode; live only when net profit is positive',
    ],
    arbBadge: 'Running · paper mode',
    feesTitle: 'Fees only on profit',
    feesSub:
      'Using the bot is free. Only when a trade closes in profit, a share of the net profit is taken as a fee.',
    fees: [
      ['20%', 'of net profit on winning trades', 'Losing trade = no fee'],
      ['10%', 'Level-1 referral reward', 'from your direct referrals’ fees'],
      ['5%', 'Level-2 referral reward', 'from second-level referrals’ fees'],
    ],
    feesNote:
      'Rates are set from the admin panel; the current values are always shown inside the bot.',
    faqTitle: 'FAQ',
    faq: [
      [
        'Are profits guaranteed?',
        'No. Memecoin trading is high-risk; the bot reduces losses, it does not remove them. We recommend starting in paper mode.',
      ],
      [
        'Is my wallet safe?',
        'Your private key is stored encrypted and only used to sign your own trades. You can back it up at any time.',
      ],
      [
        'What is paper mode?',
        'The bot runs every step on real prices without spending real funds, so you can see results before going live.',
      ],
      [
        'What is the minimum capital?',
        'You set the size of each buy. Because of network fees, very small amounts reduce returns.',
      ],
      [
        'How do I start?',
        'Open the bot in Telegram, press /start, create or import a wallet and set your buy settings.',
      ],
    ],
    ctaTitle: 'Ready to start?',
    ctaSub: 'Get going in under a minute, right inside Telegram.',
    risk: 'Risk warning: trading crypto, and newly launched tokens in particular, is highly risky and you may lose all of your capital. Nothing on this site is financial advice or a promise of profit. Past performance does not guarantee future results.',
    rights: 'All rights reserved.',
  },
} as const;

function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <defs>
        <linearGradient id="lg-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#a6f7cf" />
          <stop offset="100%" stopColor="#22d97a" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#lg-mark)" />
      <polyline
        points="11,33 20,24 27,29 37,15"
        fill="none"
        stroke="#07090f"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="37" cy="15" r="3.5" fill="#07090f" />
    </svg>
  );
}

/** HTML replica of the bot's sell card, for illustration. */
function CardPreview({ label }: { label: string }) {
  return (
    <figure className="lp-card" aria-label={label}>
      <div className="lp-card-top">
        <span className="lp-card-brand">
          <Logo size={26} /> GSP BANK SNIPER
        </span>
        <span className="lp-pill lp-pill-green">● POSITION CLOSED</span>
      </div>
      <div className="lp-card-token">
        <span className="lp-card-avatar">S</span>
        <div>
          <div className="lp-card-name">Sample Token</div>
          <div className="lp-card-sym">
            $SAMPLE <span className="lp-pill lp-pill-muted">PUMPSWAP</span>
          </div>
        </div>
      </div>
      <div className="lp-card-label">PROFIT / LOSS</div>
      <div className="lp-card-hero">+64.2%</div>
      <div className="lp-card-sub">
        +0.0642 SOL · <span>+$10.27</span>
      </div>
      <svg className="lp-card-chart" viewBox="0 0 300 90" preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="lg-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22d97a" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#22d97a" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M10 76 C 70 76, 90 18, 180 14 C 230 12, 250 34, 290 30 L 290 90 L 10 90 Z"
          fill="url(#lg-area)"
        />
        <path
          d="M10 76 C 70 76, 90 18, 180 14 C 230 12, 250 34, 290 30"
          fill="none"
          stroke="#22d97a"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <circle cx="10" cy="76" r="4" fill="#07090f" stroke="#f2f4fa" strokeWidth="2" />
        <circle cx="180" cy="14" r="4" fill="#07090f" stroke="#f2f4fa" strokeWidth="2" />
        <circle cx="290" cy="30" r="4" fill="#07090f" stroke="#f2f4fa" strokeWidth="2" />
      </svg>
      <div className="lp-card-grid">
        <div>
          <span>INVESTED</span>0.1000 SOL
        </div>
        <div>
          <span>RETURNED</span>0.1642 SOL
        </div>
        <div>
          <span>EXIT</span>Trailing Stop
        </div>
      </div>
      <figcaption>{label} · sample</figcaption>
    </figure>
  );
}

export function Landing() {
  const [open, setOpen] = useState<number | null>(0);
  const [menu, setMenu] = useState(false);
  const t = T.en;

  useEffect(() => {
    document.title = 'GSP Bank Sniper';
  }, []);

  const navItems: [string, string][] = [
    ['#features', t.nav.features],
    ['#how', t.nav.how],
    ['#network', t.nav.network],
    ['#arbitrage', t.nav.arb],
    ['#fees', t.nav.fees],
    ['#faq', t.nav.faq],
  ];

  return (
    <div className="lp lp-en" dir="ltr">
      <div className="lp-glow" aria-hidden />
      <header className="lp-nav">
        <div className="lp-wrap lp-nav-inner">
          <a href="#top" className="lp-brand">
            <Logo /> <span>GSP Bank Sniper</span>
          </a>
          <nav className={`lp-links ${menu ? 'lp-links-open' : ''}`}>
            {navItems.map(([href, label]) => (
              <a key={href} href={href} onClick={() => setMenu(false)}>
                {label}
              </a>
            ))}
          </nav>
          <div className="lp-nav-actions">
            <Link to="/dashboard" className="lp-btn lp-btn-ghost lp-hide-sm">
              {t.nav.dashboard}
            </Link>
            <a
              href={BOT_URL}
              className="lp-btn lp-btn-primary lp-hide-xs"
              target="_blank"
              rel="noreferrer"
            >
              {t.nav.start}
            </a>
            <button className="lp-burger" aria-label="menu" onClick={() => setMenu(!menu)}>
              ☰
            </button>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="lp-wrap lp-hero">
          <div className="lp-hero-text">
            <span className="lp-badge">● {t.badge}</span>
            <h1>
              {t.heroTitle[0]}
              <br />
              <em>{t.heroTitle[1]}</em>
            </h1>
            <p>{t.heroSub}</p>
            <div className="lp-hero-ctas">
              <a
                href={BOT_URL}
                className="lp-btn lp-btn-primary lp-btn-lg"
                target="_blank"
                rel="noreferrer"
              >
                {t.heroCta}
              </a>
              <Link to="/dashboard" className="lp-btn lp-btn-ghost lp-btn-lg">
                {t.heroCta2}
              </Link>
            </div>
            <small>{t.heroNote}</small>
          </div>
          <CardPreview label={t.cardCaption} />
        </section>

        <section className="lp-wrap lp-stats">
          {t.stats.map(([v, l]) => (
            <div key={l}>
              <strong>{v}</strong>
              <span>{l}</span>
            </div>
          ))}
        </section>

        <section id="features" className="lp-wrap lp-section">
          <h2>{t.featuresTitle}</h2>
          <div className="lp-grid4">
            {t.features.map(([icon, title, body]) => (
              <article key={title} className="lp-feature">
                <span className="lp-icon">{icon}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="how" className="lp-wrap lp-section">
          <h2>{t.howTitle}</h2>
          <ol className="lp-steps">
            {t.how.map(([title, body], i) => (
              <li key={title}>
                <span className="lp-step-n">{i + 1}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="network" className="lp-wrap lp-section lp-split">
          <div>
            <h2>{t.networkTitle}</h2>
            <p className="lp-lead">{t.networkSub}</p>
            <ul className="lp-checks">
              {t.networkPoints.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div className="lp-panel lp-tx">
            <div className="lp-tx-row">
              <span>👛 Wallet</span>
              <code>9WzD…AWWM ↗</code>
            </div>
            <div className="lp-tx-row">
              <span>🧾 Buy tx</span>
              <code>5h2k…2pQ3 ↗</code>
            </div>
            <div className="lp-tx-row">
              <span>🧾 Sell tx</span>
              <code>3aB4…7bC8 ↗</code>
            </div>
            <div className="lp-tx-foot">solscan.io · NETWORK TRADE · sample</div>
          </div>
        </section>

        <section id="arbitrage" className="lp-wrap lp-section lp-split lp-split-rev">
          <div className="lp-panel lp-arb">
            <div className="lp-arb-route">
              <span>SOL</span>
              <i>→</i>
              <span>TOKEN</span>
              <i>→</i>
              <span>SOL</span>
            </div>
            <div className="lp-arb-dex">
              <span>Raydium</span>
              <span>Orca</span>
              <span>Meteora</span>
              <span>PumpSwap</span>
            </div>
            <div className="lp-arb-line">
              <span>gross gap</span>
              <span>fees + tip + slippage</span>
              <span>net</span>
            </div>
          </div>
          <div>
            <span className="lp-badge lp-badge-blue">● {t.arbBadge}</span>
            <h2>{t.arbTitle}</h2>
            <p className="lp-lead">{t.arbSub}</p>
            <ul className="lp-checks">
              {t.arbPoints.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        </section>

        <section id="fees" className="lp-wrap lp-section">
          <h2>{t.feesTitle}</h2>
          <p className="lp-lead lp-center">{t.feesSub}</p>
          <div className="lp-grid3">
            {t.fees.map(([v, title, note], i) => (
              <div key={title} className={`lp-price ${i === 0 ? 'lp-price-main' : ''}`}>
                <strong>{v}</strong>
                <h3>{title}</h3>
                <p>{note}</p>
              </div>
            ))}
          </div>
          <p className="lp-note lp-center">{t.feesNote}</p>
        </section>

        <section id="faq" className="lp-wrap lp-section lp-faq">
          <h2>{t.faqTitle}</h2>
          {t.faq.map(([q, a], i) => (
            <div key={q} className={`lp-q ${open === i ? 'lp-q-open' : ''}`}>
              <button onClick={() => setOpen(open === i ? null : i)}>
                <span>{q}</span>
                <b>{open === i ? '−' : '+'}</b>
              </button>
              {open === i && <p>{a}</p>}
            </div>
          ))}
        </section>

        <section className="lp-wrap lp-cta">
          <h2>{t.ctaTitle}</h2>
          <p>{t.ctaSub}</p>
          <a
            href={BOT_URL}
            className="lp-btn lp-btn-primary lp-btn-lg"
            target="_blank"
            rel="noreferrer"
          >
            {t.heroCta}
          </a>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-wrap">
          <p className="lp-risk">{t.risk}</p>
          <div className="lp-foot-row">
            <span className="lp-brand">
              <Logo size={28} /> <span>GSP Bank Sniper</span>
            </span>
            <span>
              © {new Date().getFullYear()} GSP Bank Sniper · {t.rights}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
