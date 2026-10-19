import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useWalletConnection } from '../lib/WalletContext.js';
import { fetchMarkets, BOT_URL, type MarketToken } from '../lib/publicMarket.js';
import { Icon, Logo, Button, Panel, Badge, Token, Change, Empty, Risk } from '../neon/ui.js';
import './live.css';
export { Icon, Button, Panel, Badge, Token, Change, Empty, Risk };
interface LiveContext {
  t: (en: string, fa: string) => string;
  lang: 'en' | 'fa';
  markets: MarketToken[];
  marketStatus: string;
  refresh: () => void;
}
const C = createContext<LiveContext | null>(null);
export function useLive() { const v = useContext(C); if (!v) throw new Error('Live layout required'); return v; }
export const money = (v: number | null | undefined, suffix = '') => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 6 }) + suffix;
export const short = (v: string) => v.slice(0, 5) + '…' + v.slice(-5);

export function LiveDialog({ open, close, title, children }: { open: boolean; close: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useLive();
  useEffect(() => {
    if (!open || !ref.current) return;
    const dialog = ref.current, trigger = document.activeElement;
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus(); };
  }, [open]);
  return <dialog ref={ref} className="n-modal" aria-label={title}
    onCancel={e => { e.preventDefault(); close(); }}
    onKeyDown={e => {
      if (e.key !== 'Tab') return;
      const nodes = [...e.currentTarget.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled])')].filter(n => n.getClientRects().length);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { e.preventDefault(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }}>
    <div className="n-modal-inner"><div className="n-modal-head"><h2>{title}</h2>
      <button className="n-icon-button" type="button" onClick={close} aria-label={t('Close', 'بستن')}><Icon name="close" /></button>
    </div>{children}</div>
  </dialog>;
}

export function ProductionLayout() {
  const location = useLocation(), params = new URLSearchParams(location.search);
  // Strip demo before rendering any public page. There is no production opt-in.
  if (params.has('demo')) {
    params.delete('demo');
    return <Navigate replace to={{ pathname: location.pathname, search: params.toString(), hash: location.hash }} />;
  }
  return <LiveShell />;
}

function LiveShell() {
  const [lang, setLang] = useState<'en' | 'fa'>(() => {
    try { return localStorage.getItem('moneyland-language') === 'fa' ? 'fa' : 'en'; } catch { return 'en'; }
  });
  const t = (en: string, fa: string) => lang === 'fa' ? fa : en;
  const [menu, setMenu] = useState(false), [walletOpen, setWalletOpen] = useState(false);
  const [markets, setMarkets] = useState<MarketToken[]>([]), [marketStatus, setMarketStatus] = useState('loading');
  const [revision, setRevision] = useState(0);
  const location = useLocation(), wallet = useWalletConnection();
  useEffect(() => {
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr'; document.documentElement.lang = lang;
    try { localStorage.setItem('moneyland-language', lang); } catch { /* Optional storage. */ }
    return () => { document.documentElement.dir = 'ltr'; };
  }, [lang]);
  useEffect(() => { setMenu(false); window.scrollTo(0, 0); document.title = 'Moneyland | GSP Trading'; }, [location.pathname]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    const abort = new AbortController(); let busy = false;
    const load = async () => {
      if (document.hidden || busy) return; busy = true;
      try {
        const value = await fetchMarkets(AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]));
        if (!abort.signal.aborted) { setMarkets(value); setMarketStatus(value.length ? 'ready' : 'empty'); }
      } catch { if (!abort.signal.aborted) { setMarkets([]); setMarketStatus('unavailable'); } }
      finally { busy = false; }
    };
    void load(); const timer = setInterval(() => void load(), 20000); const visible = () => void load();
    document.addEventListener('visibilitychange', visible);
    return () => { abort.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [revision]);
  const links = [
    ['/trade', 'swap', 'Markets', 'بازارها'], ['/copy', 'copy', 'Copy trading', 'کپی‌ترید'],
    ['/arbitrage', 'arbitrage', 'Arbitrage research', 'پژوهش آربیتراژ'],
    ['/portfolio', 'wallet', 'Portfolio', 'دارایی‌ها'], ['/research', 'search', 'Research tools', 'ابزارهای پژوهش'],
  ];
  return <C.Provider value={{ t, lang, markets, marketStatus, refresh: () => setRevision(x => x + 1) }}>
    <div className="neon live-production" dir={lang === 'fa' ? 'rtl' : 'ltr'}>
      <a className="n-skip" href="#live-main">{t('Skip to content', 'رفتن به محتوا')}</a>
      <header className="n-header"><div className="n-container n-header-inner">
        <Link to="/" aria-label={t('Moneyland home', 'صفحه اصلی مانی‌لند')}><Logo /></Link>
        <nav className="n-desktop-nav" aria-label={t('Navigation', 'ناوبری')}>
          {links.slice(0, 3).map(([p, , en, fa]) => <Link key={p} to={p!}>{t(en!, fa!)}</Link>)}
        </nav>
        <div className="n-header-actions">
          <button className="n-language" type="button" onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')} aria-label={t('Switch to Persian', 'تغییر زبان به انگلیسی')}>{lang === 'fa' ? 'EN' : 'فارسی'}</button>
          <Button className="n-header-wallet" onClick={() => setWalletOpen(true)} aria-label={t('Connect wallet', 'اتصال کیف پول')}><Icon name="wallet" size={17} /><span>{wallet.state.account ? short(wallet.state.account.address) : t('Connect Wallet', 'اتصال کیف پول')}</span></Button>
          <button type="button" className="n-icon-button n-mobile-menu" aria-expanded={menu} aria-controls="live-products" aria-label={t('Menu', 'منو')} onClick={() => setMenu(x => !x)}><Icon name="menu" /></button>
        </div>
      </div>{menu && <nav id="live-products" className="n-mega" aria-label={t('Products', 'محصولات')}><div className="n-container n-mega-grid">{links.map(([p, icon, en, fa]) => <Link key={p} to={p!}><Icon name={icon} />{t(en!, fa!)}</Link>)}</div></nav>}</header>
      <main id="live-main" className={location.pathname === '/' ? '' : 'n-container n-app-main'}><Outlet /></main>
      <footer className="n-footer"><div className="n-container"><div className="live-footer-links">
        <Logo /><Link to="/copy">{t('Real copy-trading data', 'داده واقعی کپی‌ترید')}</Link><Link to="/dashboard">{t('Your account', 'حساب کاربری')}</Link>
        <Link to="/availability">{t('Service availability', 'وضعیت سرویس‌ها')}</Link><a href={BOT_URL} rel="noreferrer" target="_blank">Telegram</a>
      </div><p className="n-disclaimer">{t('Capital is at risk. Rankings describe recorded history, not guaranteed returns or the best wallets in the entire market. Unavailable data stays unavailable. Wallet connection alone grants no trading permission.', 'سرمایه در معرض ریسک است. رتبه‌ها بیانگر سابقه ثبت‌شده‌اند؛ نه سود تضمینی یا برترین کیف‌پول‌های کل بازار. داده ناموجود جایگزین نمی‌شود. اتصال کیف پول به‌تنهایی مجوز معامله نیست.')}</p></div></footer>
      <nav className="n-bottom-nav" aria-label={t('Mobile navigation', 'ناوبری موبایل')}>{links.filter(l => l[0] !== '/arbitrage').map(([p, icon, en, fa]) => <Link key={p} to={p!} className={location.pathname === p ? 'active' : ''}><Icon name={icon} />{t(en!, fa!)}</Link>)}</nav>
      <LiveDialog open={walletOpen} close={() => setWalletOpen(false)} title={t('Connect Solana wallet', 'اتصال کیف پول سولانا')}>
        <p className="n-muted n-modal-copy">{t('Only your public address is requested. This directory does not enable copying or change account permissions.', 'فقط آدرس عمومی خوانده می‌شود. این فهرست کپی را فعال نمی‌کند و مجوز حساب را تغییر نمی‌دهد.')}</p>
        {wallet.state.account ? <><p className="n-address" dir="ltr">{wallet.state.account.address}</p><Button variant="secondary" onClick={() => void wallet.disconnect()}>{t('Disconnect', 'قطع اتصال')}</Button></>
          : wallet.state.available.length ? wallet.state.available.map(w => <button key={w.name} className="n-wallet-option" type="button" disabled={wallet.state.status !== 'disconnected'} onClick={() => void wallet.connect(w)}>{w.name}<Icon /></button>)
          : <Empty title={t('No compatible wallet detected', 'کیف پول سازگار شناسایی نشد')} text={t('Open a Solana wallet browser or enable its extension. Never share a recovery phrase.', 'از مرورگر کیف پول سولانا یا افزونه آن استفاده کن. عبارت بازیابی را به اشتراک نگذار.')}><Button variant="secondary" onClick={wallet.refresh}>{t('Check again', 'بررسی دوباره')}</Button></Empty>}
        {wallet.state.error && <Risk>{wallet.state.error}</Risk>}
      </LiveDialog>
    </div>
  </C.Provider>;
}

export function LiveMarketTable({ limit = 20 }: { limit?: number }) {
  const { t, markets, marketStatus, refresh } = useLive();
  return <Panel title={t('Observed Solana markets', 'بازارهای مشاهده‌شده سولانا')} action={<Badge tone={marketStatus === 'ready' ? 'cyan' : ''}>{marketStatus === 'ready' ? t('API DATA', 'داده API') : t('SOURCE NOT READY', 'منبع آماده نیست')}</Badge>}>
    <div className="n-table-scroll"><table><thead><tr><th>{t('Asset', 'دارایی')}</th><th>{t('Price USD', 'قیمت دلار')}</th><th>{t('24h change', 'تغییر ۲۴ساعته')}</th></tr></thead><tbody>
      {markets.slice(0, limit).map(m => <tr key={m.mint}><td><span className="n-asset"><Token symbol={m.symbol} color={m.color} /><span><strong>{m.symbol}</strong><small>{m.name}</small></span></span></td><td className="n-number" dir="ltr">{money(m.price)}</td><td><Change value={m.change} /></td></tr>)}
    </tbody></table></div>
    {!markets.length && <Empty title={marketStatus === 'loading' ? t('Connecting to market source', 'اتصال به منبع بازار') : t('Market data unavailable', 'داده بازار در دسترس نیست')} text={t('No generated prices, charts or balances are substituted.', 'قیمت، نمودار یا موجودی ساختگی جایگزین نشده است.')}><Button onClick={refresh} variant="secondary">{t('Refresh', 'تازه‌سازی')}</Button></Empty>}
  </Panel>;
}

export function LiveHome() {
  const { t } = useLive();
  const cards = [
    ['/copy', 'copy', 'Ranked wallets', 'رتبه‌بندی کیف‌پول‌ها', 'Recorded exits and provider-reported statistics, refreshed automatically.', 'خروج‌های ثبت‌شده و آمار گزارش‌شده منبع؛ با به‌روزرسانی خودکار.'],
    ['/arbitrage', 'arbitrage', 'Arbitrage research', 'پژوهش آربیتراژ', 'Inspect quotes and costs. A quote is not an executed trade.', 'قیمت‌ها و هزینه‌ها را بررسی کن؛ استعلام قیمت به معنی معامله انجام‌شده نیست.'],
    ['/portfolio', 'wallet', 'Your actual portfolio', 'سبد واقعی تو', 'Sign in to view account assets and transaction history.', 'برای مشاهده دارایی و تاریخچه واقعی حساب وارد شو.'],
  ];
  return <><section className="n-hero"><div className="n-hero-grid" aria-hidden="true" /><div className="n-container n-hero-inner"><div className="n-hero-copy">
    <span className="n-eyebrow">MONEYLAND · SOLANA</span><h1>{t('Real history.', 'سابقه واقعی.')}<br /><span>{t('Your next move.', 'تصمیم بعدی تو.')}</span></h1>
    <p className="n-hero-lead">{t('Review recorded wallet performance and current market observations. Source and timestamp stay visible; account execution is separate.', 'عملکرد ثبت‌شده کیف‌پول‌ها و داده فعلی بازار را بررسی کن. منبع و زمان دریافت مشخص است؛ اجرای حساب، موضوعی جداست.')}</p>
    <div className="n-hero-ctas"><Link className="n-btn n-btn-primary" to="/copy">{t('View ranked traders', 'مشاهده رتبه معامله‌گران')}<Icon /></Link><Link className="n-btn n-btn-secondary" to="/trade">{t('Explore markets', 'بررسی بازار')}</Link></div>
  </div><LiveMarketTable limit={5} /></div></section><section className="n-container n-section"><div className="n-section-head"><h2>{t('Evidence before execution.', 'شواهد پیش از اجرا.')}</h2><p>{t('Service status, source and limits stay visible.', 'وضعیت سرویس، منبع داده و محدودیت‌ها مشخص می‌مانند.')}</p></div>
    <div className="live-product-grid">{cards.map(([p, icon, en, fa, desc, descFa]) => <Link to={p!} key={p} className="n-product-card"><span className="n-product-icon"><Icon name={icon} /></span><h3>{t(en!, fa!)}</h3><p>{t(desc!, descFa!)}</p><span className="n-product-explore">{t('Open', 'ورود')}<Icon /></span></Link>)}</div>
  </section></>;
}
export function LiveMarkets() {
  const { t } = useLive();
  return <><div className="n-page-title"><div><span className="n-eyebrow">SOLANA · API</span><h1>{t('Market research', 'پژوهش بازار')}</h1><p>{t('Current observations only. No synthetic order book, chart or filled order.', 'فقط داده دریافتی؛ بدون دفتر سفارش، نمودار یا سفارش انجام‌شده ساختگی.')}</p></div><Link className="n-btn n-btn-secondary" to="/dashboard">{t('Open account', 'ورود به حساب')}</Link></div><LiveMarketTable /></>;
}
export function Unavailable() {
  const { t } = useLive();
  return <Panel title={t('Service availability', 'وضعیت سرویس')}><Empty title={t('This execution service is not connected', 'سرویس اجرای این بخش متصل نیست')} text={t('No paper trades, invented balances or illustrative results are shown. The real copy-trading directory and existing account tools remain available.', 'هیچ معامله آزمایشی، موجودی ساختگی یا نتیجه نمایشی نشان داده نمی‌شود. فهرست واقعی کپی‌ترید و ابزارهای فعلی حساب در دسترس‌اند.')}><Link className="n-btn n-btn-primary" to="/copy">{t('Open ranked directory', 'ورود به فهرست رتبه‌بندی')}</Link></Empty></Panel>;
}
