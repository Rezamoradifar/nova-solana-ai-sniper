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
import { fetchMarkets, type MarketToken } from '../lib/publicMarket.js';
import { useWalletConnection } from '../lib/WalletContext.js';
import './moneyland-v2.css';

export type Language = 'en' | 'fa';
type IconName =
  | 'menu' | 'close' | 'chevron' | 'arrow' | 'wallet' | 'chart' | 'swap' | 'copy'
  | 'scan' | 'rocket' | 'flash' | 'bot' | 'dashboard' | 'shield' | 'globe'
  | 'search' | 'activity' | 'check' | 'lock' | 'refresh' | 'settings' | 'plus'
  | 'clock' | 'warning' | 'external' | 'play' | 'pause' | 'trending' | 'layers'
  | 'bell' | 'info' | 'link' | 'users' | 'filter' | 'history' | 'spark';

const dictionary: Record<Language, Record<string, string>> = {
  en: {
    brand: 'MONEYLAND', home: 'Home', products: 'Products', markets: 'Markets',
    launch: 'Launch platform', connect: 'Connect wallet', connected: 'Wallet connected',
    trade: 'Trade', overview: 'Overview', dex: 'DEX Trading', exchange: 'Exchange',
    copy: 'Copy Trading', arbitrage: 'Arbitrage', memes: 'Meme Coin Hub',
    flash: 'Flash Loans', bots: 'Trading Bots', portfolio: 'Portfolio',
    language: 'Language', features: 'Features', resources: 'Resources',
    security: 'Security & Risk', botlink: 'Telegram', documentation: 'Documentation',
    dashboard: 'Account dashboard', viewMarkets: 'Explore markets', seeAll: 'See all',
    live: 'Live observations', offline: 'Feed unavailable', loading: 'Connecting to live markets',
    observed: 'Observed', estimated: 'Estimated', demo: 'Illustrative UI',
    coming: 'Integration pending', readOnly: 'Read-only', openTool: 'Open connected tool',
    startTrading: 'Start trading', learnMore: 'Explore platform', viewTools: 'View all products',
    riskNote: 'Digital assets are volatile. Quotes are not executable prices or guaranteed profits.',
    limited: 'This preview does not place orders, move funds or execute transactions.',
    notAvailable: 'Not available', notConnected: 'Not connected', update: 'Updated',
    refresh: 'Refresh', searching: 'Search assets...', connectAction: 'Manage wallet',
    readyToExplore: 'Discover every side of the market.', bridgeText: 'One interface. Different strategies. Clear boundaries between data, analysis and execution.',
    noOrders: 'No orders from an exchange account are connected to this preview.',
    walletNeeded: 'Connect your wallet to see the approved public address.',
    viewLive: 'Open live Solana tool', simulation: 'Simulation only',
    close: 'Close', settings: 'Settings', executionLocked: 'Live execution not connected',
    footerTitle: 'Navigate markets with clarity.', about: 'Market intelligence and research tools for informed decisions on Solana.',
    source: 'Powered by external market data sources. Availability may vary.',
    disclosure: 'No investment advice. Never treat a simulated return as an executed gain.',
    copied: 'Copied to clipboard', saveDemo: 'Saved to this demo session',
    docs: 'Design system', notAudited: 'Independent audit status is not verified',
    workspace: 'Trading workspace', orderPreview: 'Order entry preview',
    goBack: 'Back to home',
  },
  fa: {
    brand: 'مانی‌لند', home: 'خانه', products: 'محصولات', markets: 'بازارها',
    launch: 'ورود به پلتفرم', connect: 'اتصال کیف پول', connected: 'کیف پول متصل',
    trade: 'معامله', overview: 'نمای کلی', dex: 'معاملات غیرمتمرکز', exchange: 'صرافی',
    copy: 'کپی‌تریدینگ', arbitrage: 'آربیتراژ', memes: 'میم‌کوین‌ها',
    flash: 'فلش‌لون', bots: 'ربات‌های معاملاتی', portfolio: 'سبد دارایی',
    language: 'زبان', features: 'امکانات', resources: 'منابع',
    security: 'امنیت و ریسک', botlink: 'تلگرام', documentation: 'مستندات',
    dashboard: 'داشبورد حساب', viewMarkets: 'مشاهده بازارها', seeAll: 'مشاهده همه',
    live: 'داده‌های زنده', offline: 'داده در دسترس نیست', loading: 'در حال دریافت بازار',
    observed: 'مشاهده‌شده', estimated: 'تخمینی', demo: 'نمای نمایشی',
    coming: 'اتصال هنوز آماده نیست', readOnly: 'فقط مشاهده', openTool: 'بازکردن ابزار متصل',
    startTrading: 'شروع معامله', learnMore: 'معرفی پلتفرم', viewTools: 'همه محصولات',
    riskNote: 'دارایی دیجیتال پرریسک است. قیمت‌ها و سودهای تخمینی تضمین‌شده نیستند.',
    limited: 'این پیش‌نمایش سفارش ثبت نمی‌کند و دارایی جابه‌جا نمی‌کند.',
    notAvailable: 'در دسترس نیست', notConnected: 'متصل نیست', update: 'بروزرسانی',
    refresh: 'بروزرسانی', searching: 'جست‌وجوی دارایی...', connectAction: 'مدیریت کیف پول',
    readyToExplore: 'همه بازارها، یک نمای هوشمند.', bridgeText: 'یک محیط برای استراتژی‌های مختلف؛ با تفکیک شفاف داده، تحلیل و اجرای واقعی.',
    noOrders: 'سفارش واقعی به این پیش‌نمایش صرافی متصل نشده است.',
    walletNeeded: 'برای مشاهده آدرس عمومی، کیف پول خود را متصل کنید.',
    viewLive: 'بازکردن ابزار زنده سولانا', simulation: 'فقط شبیه‌سازی',
    close: 'بستن', settings: 'تنظیمات', executionLocked: 'اجرای واقعی متصل نیست',
    footerTitle: 'با دید روشن‌تر معامله کنید.', about: 'ابزارهای تحلیل بازار و تحقیق برای تصمیم‌گیری آگاهانه در شبکه سولانا.',
    source: 'داده‌ها از منابع بازار خارجی می‌آیند و ممکن است موقتاً قطع شوند.',
    disclosure: 'توصیه سرمایه‌گذاری نیست. سود شبیه‌سازی‌شده را با سود واقعی اشتباه نگیرید.',
    copied: 'در کلیپ‌بورد کپی شد', saveDemo: 'در همین پیش‌نمایش ذخیره شد',
    docs: 'سیستم طراحی', notAudited: 'وضعیت حسابرسی مستقل تأیید نشده است',
    workspace: 'محیط معاملاتی', orderPreview: 'پیش‌نمایش سفارش',
    goBack: 'بازگشت به خانه',
  },
};

interface MarketFeed {
  tokens: MarketToken[];
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
  refresh: () => void;
}
const FeedContext = createContext<MarketFeed>({
  tokens: [], loading: true, error: null, updatedAt: null, refresh: () => {},
});
const LocaleContext = createContext<{
  lang: Language;
  setLang: (next: Language) => void;
  t: (key: string) => string;
}>({ lang: 'en', setLang: () => {}, t: (key) => key });
const ToastContext = createContext<(message: string) => void>(() => {});
const WalletDialogContext = createContext<() => void>(() => {});

export function useML() { return useContext(LocaleContext); }
export function useMLFeed() { return useContext(FeedContext); }
export function useMLToast() { return useContext(ToastContext); }
export function useWalletDialog() { return useContext(WalletDialogContext); }

export function Glyph({ name, size = 20, className = '' }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    close: <path d="M5 5l14 14M19 5 5 19" />,
    chevron: <path d="m7 10 5 5 5-5" />,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    wallet: <><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M3 9V6a3 3 0 0 1 3-3h13M15 13h6" /></>,
    chart: <><path d="M3 20h18M4 16l5-5 4 3 7-9" /><path d="M16 5h4v4" /></>,
    swap: <><path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15 8V4H4v11h4" /></>,
    scan: <path d="M3 9V3h6m6 0h6v6m0 6v6h-6m-6 0H3v-6M3 12h18" />,
    rocket: <><path d="m6 15 3 3 6-6m-7 3-3 5m10-8 5-3-5-5-3 5" /><path d="M9 9c3-3 6-4 11-5-1 5-2 8-5 11" /></>,
    flash: <path d="m13 2-9 12h7l-1 8 10-13h-7l0-7Z" />,
    bot: <><rect x="4" y="7" width="16" height="13" rx="3" /><path d="M12 7V3m-4 9h.01M16 12h.01M8 16h8" /></>,
    dashboard: <><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="5" rx="2" /><rect x="3" y="13" width="8" height="8" rx="2" /><rect x="13" y="10" width="8" height="11" rx="2" /></>,
    shield: <><path d="m12 2 9 4v6c0 5-3.5 8-9 10-5.5-2-9-5-9-10V6l9-4Z" /><path d="m8 12 3 3 5-6" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c-5 5-5 13 0 18m0-18c5 5 5 13 0 18" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></>,
    activity: <path d="M2 12h4l3-7 5 14 3-7h5" />,
    check: <path d="m4 12 5 5L20 6" />,
    lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.8 9a7 7 0 0 1 12.4-2M18.2 15a7 7 0 0 1-12.4 2" /></>,
    settings: <><circle cx="12" cy="12" r="4" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>,
    plus: <path d="M12 4v16M4 12h16" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l4 2" /></>,
    warning: <><path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v5m0 3h.01" /></>,
    external: <><path d="M13 5h6v6m0-6-9 9" /><path d="M19 14v5H5V5h5" /></>,
    play: <path d="m8 5 11 7-11 7V5Z" />,
    pause: <path d="M8 5v14m8-14v14" />,
    trending: <path d="m3 17 7-7 4 4 7-7m-6 0h6v6" />,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0v5l-2 3h16l-2-3V8m-8 11h4" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" /></>,
    users: <><circle cx="9" cy="8" r="3" /><path d="M2 20v-2a6 6 0 0 1 12 0v2M16 6a3 3 0 0 1 0 6m2 4a4 4 0 0 1 4 4" /></>,
    filter: <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" />,
    history: <><path d="M3 12a9 9 0 1 1 3 7M3 16v-4h4" /><path d="M12 6v6l4 2" /></>,
    spark: <path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z" />,
  };
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export const productLinks: { key: string; icon: IconName; route: string; hint: string }[] = [
  { key: 'overview', icon: 'dashboard', route: '/terminal', hint: 'Portfolio intelligence' },
  { key: 'dex', icon: 'swap', route: '/terminal/dex', hint: 'Multi-chain swap preview' },
  { key: 'exchange', icon: 'chart', route: '/terminal/exchange', hint: 'Spot & futures workspace' },
  { key: 'copy', icon: 'copy', route: '/terminal/copy', hint: 'Smart wallet signals' },
  { key: 'arbitrage', icon: 'scan', route: '/terminal/arbitrage', hint: 'Cross-venue route scanner' },
  { key: 'memes', icon: 'rocket', route: '/terminal/memes', hint: 'Token launch research' },
  { key: 'flash', icon: 'flash', route: '/terminal/flash', hint: 'Simulation builder' },
  { key: 'bots', icon: 'bot', route: '/terminal/bots', hint: 'Automated strategies' },
  { key: 'portfolio', icon: 'wallet', route: '/terminal/portfolio', hint: 'Assets and activity' },
];

export function Panel({ children, className = '', title, action }: {
  children: ReactNode; className?: string; title?: string; action?: ReactNode;
}) {
  return <section className={'ml2-panel ' + className}>
    {title && <div className="ml2-panel-heading"><h2>{title}</h2>{action}</div>}
    {children}
  </section>;
}

export function Pill({ children, color = 'muted' }: {
  children: ReactNode; color?: 'muted' | 'cyan' | 'purple' | 'green' | 'red';
}) {
  return <span className={'ml2-pill ml2-pill-' + color}>{children}</span>;
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return <div className="ml2-skeleton-set" aria-label="Loading" role="status">
    {Array.from({ length: lines }).map((_, n) => <span className="ml2-skeleton" key={n} />)}
  </div>;
}

export function Modal({ children, title, open, onClose }: {
  children: ReactNode; title: string; open: boolean; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const getFocusable = () =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) || []);
    getFocusable()[0]?.focus();
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const focusable = getFocusable();
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeys);
    return () => {
      window.removeEventListener('keydown', handleKeys);
      previous?.focus();
    };
  }, [open]);
  if (!open) return null;
  return <div className="ml2-modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="ml2-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <div className="ml2-modal-heading"><h2>{title}</h2>
        <button type="button" className="ml2-icon-button" aria-label="Close" onClick={onClose}>
          <Glyph name="close" />
        </button>
      </div>
      {children}
    </section>
  </div>;
}

function ContextProviders({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    try { return window.localStorage.getItem('moneyland-language') === 'fa' ? 'fa' : 'en'; }
    catch { return 'en'; }
  });
  const [tokens, setTokens] = useState<MarketToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const { state: walletState, connect, disconnect, refresh: refreshWallets } = useWalletConnection();
  const inFlight = useRef<AbortController | null>(null);
  const t = useCallback((key: string) => dictionary[lang][key] || dictionary.en[key] || key, [lang]);
  const setLang = (next: Language) => {
    setLangState(next);
    try { window.localStorage.setItem('moneyland-language', next); } catch { /* storage optional */ }
  };
  const refresh = useCallback(() => {
    if (inFlight.current || document.hidden) return;
    const abort = new AbortController();
    inFlight.current = abort;
    setLoading(true);
    fetchMarkets(abort.signal)
      .then((next) => {
        if (abort.signal.aborted) return;
        setTokens(next);
        setError(next.length ? null : 'No validated market observations were returned.');
        setUpdatedAt(next[0]?.priceUpdatedAt ?? Date.now());
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Market source unavailable');
      })
      .finally(() => {
        if (inFlight.current === abort) inFlight.current = null;
        if (!abort.signal.aborted) setLoading(false);
      });
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refresh(), 30_000);
    const visibility = () => {
      if (document.hidden) inFlight.current?.abort();
      else refresh();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      inFlight.current?.abort();
    };
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3400);
    return () => window.clearTimeout(timer);
  }, [toast]);
  return <LocaleContext.Provider value={{ lang, setLang, t }}>
    <FeedContext.Provider value={{ tokens, loading, error, updatedAt, refresh }}>
      <ToastContext.Provider value={setToast}>
        <WalletDialogContext.Provider value={() => setWalletOpen(true)}>
          {children}
          <Modal title={t('connect')} open={walletOpen} onClose={() => setWalletOpen(false)}>
            <div className="ml2-modal-body ml2-wallet-chooser">
              {walletState.account ? <>
                <Pill color="green"><Glyph name="check" size={14}/>{t('connected')}</Pill>
                <div className="ml2-wallet-connected"><Glyph name="wallet" size={28}/>
                  <strong dir="ltr">{walletState.account.address.slice(0, 8)}…{walletState.account.address.slice(-8)}</strong>
                  <p>{lang === 'fa' ? 'اتصال فقط آدرس عمومی کیف پول را به سایت می‌دهد.' : 'Your wallet approved access to its public address. Keys remain in the wallet.'}</p>
                </div>
                <button className="ml2-outline-button ml2-full-width" type="button" onClick={() => void disconnect()}>
                  {lang === 'fa' ? 'قطع اتصال' : 'Disconnect wallet'}</button>
                <Link to="/terminal/portfolio" className="ml2-primary-button ml2-full-width" onClick={() => setWalletOpen(false)}>
                  {t('portfolio')} <Glyph name="arrow" size={16}/>
                </Link>
              </> : <>
                <Notice title={lang === 'fa' ? 'اتصال ایمن' : 'Secure wallet connection'} tone="info">
                  {lang === 'fa' ? 'تنها کیف پول‌های موجود در مرورگر نمایش داده می‌شوند. هیچ کلید خصوصی یا امضای تراکنش دریافت نمی‌شود.' : 'Only wallets detected in this browser are shown. Connecting does not authorize payments or share private keys.'}
                </Notice>
                {walletState.available.length ? <div className="ml2-wallet-option-list">
                  {walletState.available.map((wallet, index) => <button key={wallet.name + index} type="button"
                    disabled={walletState.status === 'connecting' || walletState.status === 'disconnecting'}
                    className="ml2-wallet-option" onClick={() => void connect(wallet)}>
                    <img src={wallet.icon} width="36" height="36" alt=""/><span><strong>{wallet.name}</strong><small>{lang === 'fa' ? 'در این مرورگر شناسایی شده' : 'Detected in this browser'}</small></span>
                    <Glyph name="arrow" size={17}/>
                  </button>)}
                </div> : <div className="ml2-wallet-not-detected"><Glyph name="wallet" size={31}/>
                  <strong>{lang === 'fa' ? 'کیف پول سازگار پیدا نشد' : 'No supported wallet detected'}</strong>
                  <p>{lang === 'fa' ? 'مرورگر داخل اپلیکیشن Phantom یا Solflare را باز کنید، یا افزونه کیف‌پول نصب کنید.' : 'Open the site inside Phantom/Solflare in-app browser, or install a supported browser wallet.'}</p>
                  <button className="ml2-outline-button" type="button" onClick={() => refreshWallets()}><Glyph name="refresh" size={16}/>{t('refresh')}</button>
                </div>}
                {walletState.status === 'connecting' && <p className="ml2-wallet-pending" role="status">{lang === 'fa' ? 'در انتظار تأیید داخل کیف پول…' : 'Waiting for approval in your wallet…'}</p>}
                {walletState.error && <Notice tone="warn">{walletState.error}</Notice>}
                <Link to="/wallet" onClick={() => setWalletOpen(false)} className="ml2-text-link">
                  {lang === 'fa' ? 'راهنمای اتصال موبایل' : 'Mobile wallet connection guide'} <Glyph name="arrow" size={16}/>
                </Link>
              </>}
            </div>
          </Modal>
        </WalletDialogContext.Provider>
        {toast && <div className="ml2-toast" role="status"><Glyph name="check" size={17} />{toast}</div>}
      </ToastContext.Provider>
    </FeedContext.Provider>
  </LocaleContext.Provider>;
}

function MLNavigation() {
  const { t, lang, setLang } = useML();
  const { state } = useWalletConnection();
  const openWallet = useWalletDialog();
  const [menu, setMenu] = useState(false);
  const [mega, setMega] = useState(false);
  const location = useLocation();
  useEffect(() => { setMenu(false); setMega(false); }, [location.pathname]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenu(false); setMega(false); }
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  return <header className="ml2-topbar">
    <div className="ml2-header-inner">
      <Link to="/" className="ml2-logo" aria-label="Moneyland home">
        <span className="ml2-logo-mark">M<span>↗</span></span>
        <span className="ml2-logo-name">MONEY<span>LAND</span><small>THE INTELLIGENT TRADING LAYER</small></span>
      </Link>
      <nav className="ml2-desktop-nav" aria-label="Primary">
        <Link to="/">{t('home')}</Link>
        <div className="ml2-mega-host">
          <button type="button" aria-expanded={mega} aria-controls="ml2-mega-menu"
            onClick={() => setMega(!mega)}>{t('products')} <Glyph name="chevron" size={14} /></button>
          {mega && <div className="ml2-mega" id="ml2-mega-menu">
            <span className="ml2-micro">EXPLORE THE WORKSPACE / 09 MODULES</span>
            <div className="ml2-mega-grid">
              {productLinks.map((p) => <Link to={p.route} key={p.route} className="ml2-mega-item">
                <span className="ml2-mega-icon"><Glyph name={p.icon} size={19} /></span>
                <span><strong>{t(p.key)}</strong><small>{p.hint}</small></span>
              </Link>)}
            </div>
          </div>}
        </div>
        <Link to="/terminal/dex">{t('trade')}</Link>
        <Link to="/markets">{t('markets')}</Link>
        <Link to="/security">{t('security')}</Link>
      </nav>
      <div className="ml2-header-actions">
        <button className="ml2-language" type="button" onClick={() => setLang(lang === 'en' ? 'fa' : 'en')}
          aria-label={lang === 'en' ? 'Switch to Persian' : 'Switch to English'}>
          <Glyph name="globe" size={16}/><span>{lang === 'en' ? 'FA' : 'EN'}</span>
        </button>
        <button type="button" onClick={openWallet} className="ml2-outline-button ml2-wallet-top">
          <Glyph name="wallet" size={17} />
          {state.account ? state.account.address.slice(0, 5) + '…' : t('connect')}
        </button>
        <Link to="/terminal" className="ml2-primary-button ml2-launch">{t('launch')} <Glyph name="arrow" size={16} /></Link>
        <button className="ml2-icon-button ml2-mobile-toggle" aria-label={menu ? 'Close menu' : 'Open menu'}
          aria-expanded={menu} aria-controls="ml2-mobile-nav" onClick={() => setMenu(!menu)}>
          <Glyph name={menu ? 'close' : 'menu'} size={22} />
        </button>
      </div>
    </div>
    {menu && <nav id="ml2-mobile-nav" className="ml2-mobile-menu" aria-label="Mobile navigation">
      <Link to="/">{t('home')}</Link>
      {productLinks.map((p) => <Link to={p.route} key={p.route}>
        <Glyph name={p.icon} size={17} />{t(p.key)}
      </Link>)}
      <Link to="/wallet"><Glyph name="wallet" size={17}/>{t('connectAction')}</Link>
    </nav>}
  </header>;
}

function MLSidebar() {
  const { t } = useML();
  return <aside className="ml2-sidebar" aria-label="Trading module navigation">
    <div className="ml2-sidebar-label">WORKSPACE / MENU</div>
    <nav>
      {productLinks.map((p) => <NavLink key={p.route} to={p.route} end={p.route === '/terminal'}
        className={({ isActive }) => 'ml2-side-link' + (isActive ? ' active' : '')}>
        <Glyph name={p.icon} size={18} /><span>{t(p.key)}</span><Glyph name="arrow" size={13} className="ml2-side-arrow" />
      </NavLink>)}
    </nav>
    <div className="ml2-sidebar-help">
      <Glyph name="shield" size={22} />
      <strong>{t('security')}</strong>
      <p>{t('limited')}</p>
      <Link to="/security">{t('learnMore')} ↗</Link>
    </div>
  </aside>;
}

function MLFooter() {
  const { t } = useML();
  return <footer className="ml2-footer">
    <div className="ml2-footer-grid">
      <div><Link to="/" className="ml2-footer-logo">MONEY<span>LAND</span> ✦</Link>
        <h3>{t('footerTitle')}</h3><p>{t('about')}</p>
      </div>
      <div><strong>{t('products')}</strong><Link to="/terminal/dex">{t('dex')}</Link>
        <Link to="/terminal/exchange">{t('exchange')}</Link><Link to="/terminal/copy">{t('copy')}</Link>
        <Link to="/terminal/arbitrage">{t('arbitrage')}</Link></div>
      <div><strong>{t('features')}</strong><Link to="/terminal/memes">{t('memes')}</Link>
        <Link to="/terminal/flash">{t('flash')}</Link><Link to="/terminal/bots">{t('bots')}</Link>
        <Link to="/terminal/portfolio">{t('portfolio')}</Link></div>
      <div><strong>{t('resources')}</strong><Link to="/security">{t('security')}</Link>
        <a href="https://github.com/Rezamoradifar/nova-solana-ai-sniper" target="_blank" rel="noreferrer">{t('documentation')} ↗</a>
        <Link to="/telegram">{t('botlink')}</Link><Link to="/pricing">Plans</Link></div>
    </div>
    <div className="ml2-footer-bottom"><span>© {new Date().getFullYear()} MONEYLAND · GSP TRADING</span>
      <span>{t('disclosure')}</span><span>moneyland.tr</span>
    </div>
  </footer>;
}

function MoneylandContents() {
  const { lang, t } = useML();
  const location = useLocation();
  const isWorkspace = location.pathname.startsWith('/terminal');
  useEffect(() => {
    document.title = 'Moneyland — ' + (isWorkspace ? t('workspace') : 'One trading workspace');
    document.documentElement.lang = lang;
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [lang, location.pathname, isWorkspace, t]);
  return <div className="ml2-root" dir={lang === 'fa' ? 'rtl' : 'ltr'}>
    <a className="ml2-skip" href="#ml2-main">Skip to main content</a>
    <MLNavigation />
    {isWorkspace
      ? <div className="ml2-workspace"><MLSidebar/><main id="ml2-main" className="ml2-workspace-main"><Outlet /></main></div>
      : <main id="ml2-main"><Outlet /></main>}
    <MLFooter />
  </div>;
}

export function MoneylandFrame() {
  return <ContextProviders><MoneylandContents /></ContextProviders>;
}
