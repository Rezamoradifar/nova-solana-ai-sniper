import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { BOT_URL, fetchMarkets, money, pct, type MarketToken } from '../../lib/publicMarket.js';
import '../../landing.css';

export function Icon({
  name,
  size = 20,
}: {
  name:
    | 'menu'
    | 'close'
    | 'activity'
    | 'layers'
    | 'shield'
    | 'scan'
    | 'refresh'
    | 'search'
    | 'chevron'
    | 'check'
    | 'external'
    | 'download'
    | 'play'
    | 'pause'
    | 'globe'
    | 'sliders';
  size?: number;
}) {
  const paths: Record<string, ReactNode> = {
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8l10-5Z" />
        <path d="m2 12 10 5 10-5M2 16l10 5 10-5" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    scan: (
      <>
        <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 12h18" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 8a8 8 0 1 0 .5 7M20 3v5h-5" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    chevron: <path d="m8 10 4 4 4-4" />,
    check: <path d="m5 12 4 4L19 6" />,
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14" />
        <path d="M10 3H3v18h18v-7" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" />
      </>
    ),
    play: <path d="m8 4 12 8-12 8V4Z" />,
    pause: (
      <>
        <path d="M8 4v16M16 4v16" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <path d="M3 12h18" />
      </>
    ),
    sliders: (
      <>
        <path d="M4 7h5m4 0h7M4 17h9m4 0h3" />
        <circle cx="11" cy="7" r="2" />
        <circle cx="15" cy="17" r="2" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function NovaMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`nova-brand ${small ? 'small' : ''}`}>
      <svg viewBox="0 0 36 36" width="33" height="33" fill="none" aria-hidden="true">
        <path
          d="M27 9a12 12 0 1 0 1 17v-8H18"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="square"
        />
      </svg>
      <span className="brand-word">
        GSP<span>BANK SNIPER</span>
      </span>
    </span>
  );
}

interface MarketState {
  tokens: MarketToken[];
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
  refresh: () => void;
}
const MarketContext = createContext<MarketState>({
  tokens: [],
  loading: true,
  error: null,
  updatedAt: null,
  refresh: () => {},
});
export const useMarkets = () => useContext(MarketContext);

function MarketProvider({ children }: { children: ReactNode }) {
  const [tokens, setTokens] = useState<MarketToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const requestRef = useRef<AbortController>();
  const refresh = useCallback(() => {
    if (document.hidden) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    fetchMarkets(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setTokens(data);
          setUpdatedAt(Date.now());
          setError(data.length ? null : 'No market data returned.');
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Market connection interrupted.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    const visible = () => {
      if (!document.hidden) refresh();
      else requestRef.current?.abort();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      requestRef.current?.abort();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  return (
    <MarketContext.Provider value={{ tokens, loading, error, updatedAt, refresh }}>
      {children}
    </MarketContext.Provider>
  );
}

export function TokenMark({ symbol, color = '#c1ff75' }: { symbol: string; color?: string }) {
  return (
    <span className="token-mark" style={{ '--token-color': color } as React.CSSProperties}>
      {symbol === 'SOL' ? '≋' : symbol.slice(0, 1)}
    </span>
  );
}

export function MarketTicker() {
  const { tokens, loading, error } = useMarkets();
  return (
    <div className="market-ticker">
      <div className="ticker-label">
        <span className={`status-dot ${error ? 'offline' : !tokens.length ? 'pending' : ''}`} />
        <span>{error ? 'Data unavailable' : tokens.length ? 'Market pulse' : 'Connecting'}</span>
        <span className="ticker-network">SOLANA</span>
      </div>
      <div className="ticker-items">
        {tokens.length ? (
          tokens.slice(0, 5).map((t) => (
            <Link to="/markets" key={t.mint} className="ticker-item">
              <span>{t.symbol}</span>
              <strong>{money(t.price)}</strong>
              <span className={t.change != null && t.change < 0 ? 'negative' : 'positive'}>
                {pct(t.change)}
              </span>
            </Link>
          ))
        ) : (
          <span className="muted ticker-wait">
            {loading
              ? 'Fetching current market prices…'
              : 'Live prices will appear when the source reconnects.'}
          </span>
        )}
      </div>
    </div>
  );
}

export function PageHeading({
  eyebrow,
  title,
  text,
  children,
}: {
  eyebrow: string;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">
          <span /> {eyebrow}
        </div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {children}
    </div>
  );
}

export function PublicLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
    const titles: Record<string, string> = {
      '/': 'A clearer edge on Solana',
      '/arbitrage': 'Live arbitrage terminal',
      '/markets': 'Solana markets',
      '/platform': 'The GSP Bank Sniper app',
      '/security': 'Risk & security',
      '/pricing': 'Packages',
    };
    document.title = `GSP Bank Sniper — ${titles[location.pathname] ?? 'Solana trading'}`;
  }, [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <MarketProvider>
      <div className="nova-site">
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <header className="nova-header">
          <div className="site-container header-inner">
            <Link to="/" aria-label="GSP Bank Sniper home">
              <NovaMark />
            </Link>
            <nav
              className={menuOpen ? 'main-nav is-open' : 'main-nav'}
              id="public-nav"
              aria-label="Main navigation"
            >
              <NavLink to="/platform">Trading app</NavLink>
              <NavLink to="/arbitrage">
                Arbitrage <span className="nav-new">LIVE</span>
              </NavLink>
              <NavLink to="/markets">Markets</NavLink>
              <NavLink to="/security">Security</NavLink>
              <NavLink to="/pricing">Packages</NavLink>
            </nav>
            <div className="header-actions">
              <a href={BOT_URL} className="nova-button button-sm" target="_blank" rel="noreferrer">
                Launch app
              </a>
              <button
                className="icon-button menu-toggle"
                aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
                aria-expanded={menuOpen}
                aria-controls="public-nav"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <Icon name={menuOpen ? 'close' : 'menu'} />
              </button>
            </div>
          </div>
        </header>
        <main id="main-content">
          <Outlet />
        </main>
        <footer className="nova-footer">
          <div className="site-container">
            <div className="footer-top">
              <div className="footer-brand">
                <Link to="/">
                  <NovaMark />
                </Link>
                <p>
                  A clearer view of Solana.
                  <br />A considered approach to every trade.
                </p>
                <span className="footer-network">
                  <Icon name="globe" size={15} /> Built around Solana
                </span>
              </div>
              <div className="footer-column">
                <h3>Explore</h3>
                <Link to="/arbitrage">Arbitrage terminal</Link>
                <Link to="/markets">Live markets</Link>
                <Link to="/platform">Trading app</Link>
              </div>
              <div className="footer-column">
                <h3>Get started</h3>
                <Link to="/pricing">Packages & access</Link>
                <a href={BOT_URL} target="_blank" rel="noreferrer">
                  Telegram app
                </a>
                <Link to="/security">Risk & security</Link>
              </div>
              <div className="footer-column">
                <h3>Resources</h3>
                <a
                  href="https://github.com/Rezamoradifar/nova-solana-ai-sniper"
                  target="_blank"
                  rel="noreferrer"
                >
                  Source & documentation
                </a>
                <a href="https://solscan.io" target="_blank" rel="noreferrer">
                  Solana explorer
                </a>
                <Link to="/platform#questions">Common questions</Link>
              </div>
            </div>
            <div className="footer-bottom">
              <span>© {new Date().getFullYear()} GSP Bank Sniper. All rights reserved.</span>
              <span>Clarity before execution.</span>
            </div>
            <p className="risk-note">
              Digital asset trading involves risk, including loss of capital. Quotes and estimated
              spreads are observations, not executed trades or guaranteed returns. Live market data
              is provided by third-party sources and may be delayed.
            </p>
          </div>
        </footer>
      </div>
    </MarketProvider>
  );
}
