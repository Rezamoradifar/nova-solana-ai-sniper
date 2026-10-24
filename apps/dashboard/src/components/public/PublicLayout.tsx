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
import {
  BOT_URL,
  PUBLIC_API_BASE,
  fetchMarkets,
  money,
  pct,
  type MarketToken,
} from '../../lib/publicMarket.js';
import { LanguageSwitch, useLanguage } from '../../lib/LanguageContext.js';
import { WalletButton } from '../WalletUI.js';
import { SiteBrand } from '../SiteBrand.js';
import { MainnetRibbon } from '../MainnetRibbon.js';
import '../../landing.css';
import '../../workspace.css';
import '../../moneyland.css';

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
    | 'sliders'
    | 'wallet'
    | 'telegram'
    | 'copy'
    | 'disconnect';
  size?: number;
}) {
  const paths: Record<string, ReactNode> = {
    wallet: (
      <>
        <path d="M20 8V5H5a2 2 0 0 0 0 4h16v11H5a2 2 0 0 1-2-2V7" />
        <path d="M21 12h-6v5h6" />
        <path d="M17 14.5h.01" />
      </>
    ),
    telegram: <path d="m21 3-4 18-6-5-4 4v-7L21 3 3 10l4 3m4 3 6-8" />,
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M15 8V4H4v11h4" />
      </>
    ),
    disconnect: (
      <>
        <path d="M10 4H4v16h6m4-12 4 4-4 4m-5-4h12" />
      </>
    ),
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
    <span className={small ? 'nova-brand small' : 'nova-brand'}>
      <SiteBrand />
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
  const previousPricesRef = useRef(new Map<string, number>());
  const refresh = useCallback(() => {
    if (document.hidden) return;
    // Let slow responses finish instead of aborting them on every polling tick.
    if (requestRef.current && !requestRef.current.signal.aborted) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    fetchMarkets(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          const now = data[0]?.priceUpdatedAt ?? Date.now();
          const previous = previousPricesRef.current;
          const next = data.map((token) => {
            const prior = previous.get(token.mint);
            const tickChangePercent =
              prior && prior > 0 ? ((token.price - prior) / prior) * 100 : 0;
            const tickDirection: MarketToken['tickDirection'] =
              tickChangePercent > 0 ? 'up' : tickChangePercent < 0 ? 'down' : 'flat';
            previous.set(token.mint, token.price);
            return {
              ...token,
              tickChangePercent,
              tickDirection,
              priceUpdatedAt: now,
            };
          });
          setTokens(next);
          setUpdatedAt(now);
          setError(data.length ? null : 'No market data returned.');
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Market connection interrupted.');
      })
      .finally(() => {
        if (requestRef.current === controller) {
          requestRef.current = undefined;
          if (!controller.signal.aborted) setLoading(false);
        }
      });
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2_000);
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
  const { t: localize } = useLanguage();
  const { tokens, loading, error } = useMarkets();
  return (
    <div className="market-ticker">
      <div className="ticker-label">
        <span className={`status-dot ${error ? 'offline' : !tokens.length ? 'pending' : ''}`} />
        <span>
          {error
            ? localize('Data unavailable')
            : tokens.length
              ? localize('Market pulse')
              : localize('Connecting')}
        </span>
        <span className="ticker-network">SOLANA</span>
      </div>
      <div className="ticker-items">
        {tokens.length ? (
          tokens.slice(0, 5).map((t) => (
            <Link to="/markets" key={t.mint} className="ticker-item">
              <span>{t.symbol}</span>
              <strong
                className={
                  t.tickDirection === 'up'
                    ? 'tick-up'
                    : t.tickDirection === 'down'
                      ? 'tick-down'
                      : ''
                }
              >
                {money(t.price)}
              </strong>
              <span className={t.tickDirection === 'down' ? 'negative' : 'positive'}>
                {t.tickDirection === 'up' ? '↑ ' : t.tickDirection === 'down' ? '↓ ' : ''}
                {pct(t.tickChangePercent)}
              </span>
            </Link>
          ))
        ) : (
          <span className="muted ticker-wait">
            {loading
              ? localize('Fetching current market prices…')
              : localize('Live prices will appear when the source reconnects.')}
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

interface PublicNetworkStatus {
  chain: 'solana';
  cluster: 'mainnet-beta';
  status: 'ready' | 'degraded' | 'not_ready';
  tradingMode: 'LIVE' | 'PAPER';
  workersReady: boolean;
  slot: number | null;
  checkedAt: number;
}

export function PublicLayout() {
  const { t: localize } = useLanguage();
  const { t } = useLanguage();
  const [menuOpen, setMenuOpen] = useState(false);
  const [network, setNetwork] = useState<PublicNetworkStatus | null>(null);
  const location = useLocation();
  useEffect(() => {
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
    const titles: Record<string, string> = {
      '/': 'Institutional Solana trading intelligence',
      '/arbitrage': 'Live arbitrage terminal',
      '/markets': 'Solana markets',
      '/platform': 'Website tools',
      '/tools': 'Website tools',
      '/telegram': 'Telegram bot',
      '/wallet': 'Connect your Solana wallet',
      '/security': 'Risk & security',
      '/pricing': 'Packages',
      '/copy-trading': 'Solana copy trading',
    };
    document.title = `Moneyland | GSP TRADING — ${t(titles[location.pathname] ?? 'Solana trading')}`;
    let canonical = document.head.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.setAttribute('rel', 'canonical');
      document.head.appendChild(canonical);
    }
    canonical.setAttribute('href', 'https://moneyland.tr' + location.pathname);
  }, [location.pathname, t]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${PUBLIC_API_BASE}/public/network/status`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(8_000),
        });
        const body = (await response.json()) as PublicNetworkStatus;
        if (active) setNetwork(body);
      } catch {
        if (active) {
          setNetwork({
            chain: 'solana',
            cluster: 'mainnet-beta',
            status: 'degraded',
            tradingMode: 'PAPER',
            workersReady: false,
            slot: null,
            checkedAt: Date.now(),
          });
        }
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  return (
    <MarketProvider>
      <div className="nova-site moneyland-theme">
        <a href="#main-content" className="skip-link">
          {localize('Skip to content')}
        </a>
        <header className="nova-header">
          <div className="site-container header-inner">
            <Link to="/" aria-label="GSP TRADING home">
              <NovaMark />
            </Link>
            <nav
              className={menuOpen ? 'main-nav is-open' : 'main-nav'}
              id="public-nav"
              aria-label={localize('Main navigation')}
            >
              <NavLink to="/tools">{localize('Platform')}</NavLink>
              <NavLink to="/arbitrage">
                {localize('Arbitrage') + ' '}
                <span className="nav-new">LIVE</span>
              </NavLink>
              <NavLink to="/markets">{localize('Markets')}</NavLink>
              <NavLink to="/research">{localize('GMGN Tools')}</NavLink>
              <NavLink to="/executions">{localize('Executions')}</NavLink>
              <NavLink to="/flash-arbitrage">{localize('Flash Loan')}</NavLink>
              <NavLink to="/copy-trading">{localize('Copy Trading')}</NavLink>
              <span className="nav-divider" aria-hidden="true" />
              <NavLink to="/telegram">
                <Icon name="telegram" size={17} />
                {' ' + localize('Telegram bot')}
              </NavLink>
              <NavLink to="/pricing">{localize('Bot packages')}</NavLink>
            </nav>
            <div className="header-actions">
              <span
                className={`status-pill network-header-status ${
                  network?.status === 'ready' ? '' : 'is-offline'
                }`}
                title={
                  network?.slot
                    ? `Solana slot ${network.slot.toLocaleString()}`
                    : localize('Solana network status')
                }
              >
                <span className={`status-dot ${network?.status === 'ready' ? '' : 'offline'}`} />
                {localize('MAINNET ·') + ' '}
                {network?.status === 'ready' ? localize('ONLINE') : localize('DEGRADED')} ·{' '}
                {network?.tradingMode ?? 'PAPER'}
              </span>
              <LanguageSwitch />
              <WalletButton className="wallet-header-link" />
              <button
                className="icon-button menu-toggle"
                aria-label={menuOpen ? localize('Close navigation') : localize('Open navigation')}
                aria-expanded={menuOpen}
                aria-controls="public-nav"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <Icon name={menuOpen ? 'close' : 'menu'} />
              </button>
            </div>
          </div>
        </header>
        <MainnetRibbon />
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
                  {localize('Institutional Solana intelligence.')}
                  <br />
                  {localize('Built for disciplined execution.')}
                </p>
                <span className="footer-network">
                  <Icon name="globe" size={15} />
                  {' ' + localize('Solana Mainnet ·')}{' '}
                  {network?.status === 'ready' ? localize('RPC online') : localize('RPC degraded')}{' '}
                  · {network?.tradingMode ?? 'PAPER'}
                </span>
              </div>
              <div className="footer-column">
                <h3>{localize('Website tools')}</h3>
                <Link to="/tools">{localize('All tools')}</Link>
                <Link to="/terminal">{localize('Trading workspace', 'محیط معاملاتی')}</Link>
                <Link to="/arbitrage">{localize('Arbitrage terminal')}</Link>
                <Link to="/markets">{localize('Live markets')}</Link>
                <Link to="/flash-arbitrage">{localize('Flash Loan Lab')}</Link>
                <Link to="/copy-trading">{localize('Copy Trading')}</Link>
                <Link to="/wallet">{localize('Connect wallet')}</Link>
              </div>
              <div className="footer-column">
                <h3>{localize('Telegram bot')}</h3>
                <Link to="/telegram">{localize('Bot overview')}</Link>
                <Link to="/pricing">{localize('Bot packages')}</Link>
                <a href={BOT_URL} target="_blank" rel="noreferrer">
                  {localize('Open Telegram bot')}
                </a>
                <Link to="/security">{localize('Risk & security')}</Link>
              </div>
              <div className="footer-column">
                <h3>{localize('Resources')}</h3>
                <a
                  href="https://github.com/Rezamoradifar/nova-solana-ai-sniper"
                  target="_blank"
                  rel="noreferrer"
                >
                  {localize('Source & documentation')}
                </a>
                <a href="https://solscan.io" target="_blank" rel="noreferrer">
                  {localize('Solana explorer')}
                </a>
                <Link to="/tools#questions">{localize('Common questions')}</Link>
              </div>
            </div>
            <div className="footer-bottom">
              <span>
                © {new Date().getFullYear()}
                {' ' + localize('GSP TRADING · moneyland.tr. All rights reserved.')}
              </span>
              <span>{localize('Clarity before execution.')}</span>
            </div>
            <p className="risk-note">
              {localize(
                'Digital asset trading involves risk, including loss of capital. Quotes and estimated spreads are observations, not executed trades or guaranteed returns. Live market data is provided by third-party sources and may be delayed.',
              )}
            </p>
          </div>
        </footer>
      </div>
    </MarketProvider>
  );
}
