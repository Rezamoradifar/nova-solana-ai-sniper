import { Link } from 'react-router-dom';
import { Button, Icon, MarketTable, Panel, useExperience } from './ui.js';
import { useMainnet } from '../lib/MainnetContext.js';
import { liveCopyBuysReady } from './realReadiness.js';
import { money, pct } from '../lib/publicMarket.js';

function SolanaSculpture() {
  return <div className="lux-sculpture" aria-hidden="true">
    <div className="lux-sculpture-aura" /><div className="lux-orbit orbit-a"/><div className="lux-orbit orbit-b"/>
    <div className="lux-orbit-point point-a"/><div className="lux-orbit-point point-b"/>
    <div className="lux-coin"><div className="lux-coin-face"><svg viewBox="0 0 200 200" fill="none">
      <defs><linearGradient id="solana-metal" x1="30" y1="20" x2="175" y2="175" gradientUnits="userSpaceOnUse"><stop stopColor="#fff2cb"/><stop offset=".42" stopColor="#dcc08c"/><stop offset="1" stopColor="#806b46"/></linearGradient></defs>
      <path d="m53 44 108 0-23 24H30l23-24ZM30 88h108l23 24H53L30 88Zm23 44h108l-23 24H30l23-24Z" fill="url(#solana-metal)"/>
    </svg><span>SOLANA</span></div></div>
    <span className="lux-axis axis-x"/><span className="lux-axis axis-y"/>
    <span className="lux-scene-coordinate">ML / 001<br/>SOLANA ECOSYSTEM</span>
  </div>;
}

export function NeonHome() {
  const { t, openWallet, tokens, demo, loading, refresh, updated } = useExperience();
  const { observation, verified, copy } = useMainnet();
  const sol = !demo ? tokens.find(token => token.symbol === 'SOL') : undefined;
  const marketTokens = demo ? [] : tokens;
  const liveCopy = verified && observation?.tradingMode === 'LIVE' && observation.workersReady && liveCopyBuysReady(copy);
  const tools = [
    { number: '01', icon: 'wallet', title: t('Your wallet. Connected.', 'کیف پول تو؛ متصل.'), text: t('One approved Solana account across your entire workspace.', 'یک حساب تأییدشدهٔ سولانا در تمام محیط کار تو.'), to: '/wallet', tag: t('WALLET CONNECT', 'اتصال کیف پول') },
    { number: '02', icon: 'copy', title: t('Follow conviction.', 'استراتژی را دنبال کن.'), text: t('Discover tracked wallets and set the limits for your copy strategy.', 'کیف پول‌های رصدشده را ببین و محدودیت استراتژی کپی را تنظیم کن.'), to: '/copy-trading', tag: liveCopy ? t('LIVE ENGINE', 'موتور واقعی') : t('ENGINE PAUSED', 'موتور متوقف') },
    { number: '03', icon: 'arbitrage', title: t('Read the opportunity.', 'فرصت را دقیق ببین.'), text: t('Compare venue quotes, liquidity and route costs in one view.', 'قیمت بازارها، نقدینگی و هزینهٔ مسیر را در یک نما مقایسه کن.'), to: '/arbitrage', tag: t('MARKET RESEARCH', 'پژوهش بازار') },
    { number: '04', icon: 'layers', title: t('Every move. Accounted.', 'هر حرکت؛ قابل پیگیری.'), text: t('Open your account history and inspect confirmed transaction records.', 'سابقهٔ حساب و رکورد تراکنش‌های تأییدشده را بررسی کن.'), to: '/executions', tag: t('TRANSACTION HISTORY', 'سابقهٔ تراکنش') },
  ];
  return <>
    <section className="lux-hero">
      <div className="lux-hero-grid" aria-hidden="true"/>
      <div className="n-container lux-hero-inner">
        <div className="lux-hero-copy">
          <div className="lux-edition"><span>GSP TRADING</span><i/>{t('THE SOLANA EDITION', 'نسخهٔ سولانا')}</div>
          <h1>{t('YOUR EDGE.', 'قدرتِ تو.')}<br/><span>{t('ON SOLANA.', 'روی سولانا.')}</span></h1>
          <p>{t('The precision of a terminal. The clarity of a single view. Your wallet, market intelligence and strategies — beautifully connected.', 'دقت یک ترمینال، وضوح یک نگاه. کیف پول، دادهٔ بازار و استراتژی‌های تو؛ در یک محیط به‌هم‌پیوسته.')}</p>
          <div className="lux-hero-actions"><Link className="n-btn n-btn-primary" to="/trade">{t('Enter the workspace', 'ورود به محیط معامله')}<Icon name="arrow" size={18}/></Link><Button variant="secondary" onClick={openWallet}><Icon name="wallet" size={18}/>{t('Connect wallet', 'اتصال کیف پول')}</Button></div>
          <div className="lux-hero-detail"><span>01 — 04</span><p>{t('Built around Solana. Designed around you.', 'بر پایهٔ سولانا. با محوریت تو.')}</p><span className="lux-scroll-cue" aria-hidden="true">↓</span></div>
        </div>
        <div className="lux-hero-visual">
          <SolanaSculpture />
          <div className="lux-quote-card">
            <div><span className="lux-small-caps">SOL / USD</span><span className={`lux-observed-dot ${sol ? 'active' : ''}`}>{sol ? t('MARKET DATA', 'دادهٔ بازار') : t('AWAITING DATA', 'در انتظار داده')}</span></div>
            <strong className="lux-price" dir="ltr" data-testid="hero-sol-price">{sol ? money(sol.price) : '—'}</strong>
            <div><span className={sol?.change != null && sol.change < 0 ? 'lux-loss' : 'lux-gain'} dir="ltr">{pct(sol?.change)} <small>24H</small></span><Link to="/markets">{t('Explore market', 'مشاهده بازار')} ↗</Link></div>
          </div>
          <div className="lux-proof-tag"><span className={verified ? 'verified' : ''}/><div><strong>{t('MAINNET CONNECTION', 'اتصال شبکهٔ اصلی')}</strong><small>{verified ? t('Genesis verified · confirmed slot', 'Genesis تأییدشده · اسلات تأییدشده') : t('Awaiting network verification', 'در انتظار تأیید شبکه')}</small></div><Icon name="shield" size={20}/></div>
        </div>
      </div>
    </section>
    <section className="n-container lux-facts" aria-label={t('Observed Solana network data', 'دادهٔ مشاهده‌شده شبکه سولانا')}>
      <div><span>{t('CONFIRMED SLOT', 'اسلات تأییدشده')}</span><strong dir="ltr">{verified ? observation?.slot?.toLocaleString('en-US') : '—'}</strong><small>Solana Mainnet</small></div>
      <div><span>{t('NON-VOTE TRANSACTIONS / SEC', 'تراکنش بدون رأی / ثانیه')}</span><strong dir="ltr">{verified && observation?.nonVoteTps != null ? observation.nonVoteTps.toLocaleString('en-US') : '—'}</strong><small>{t('Latest network sample', 'آخرین نمونهٔ شبکه')}</small></div>
      <div><span>{t('OBSERVED POOL LIQUIDITY', 'نقدینگی استخرهای منتخب')}</span><strong dir="ltr">{marketTokens.length ? money(marketTokens.reduce((sum, token) => sum + token.liquidity, 0), true) : '—'}</strong><small>{t('Selected pools · not platform TVL', 'استخرهای منتخب؛ نه TVL پلتفرم')}</small></div>
      <div><span>{t('COPY ENGINE', 'موتور کپی‌ترید')}</span><strong className="lux-engine-label">{liveCopy ? t('LIVE', 'فعال') : t('PAUSED', 'متوقف')}</strong><small>{t('Current execution readiness', 'آمادگی فعلی اجرا')}</small></div>
    </section>
    <section className="n-container lux-tool-section" id="products">
      <div className="lux-section-title"><div><span className="lux-kicker">01 / {t('THE WORKSPACE', 'محیط کار')}</span><h2>{t('Precision. By design.', 'دقت، در ذاتِ طراحی.')}</h2></div><p>{t('Four connected destinations. One continuous experience.', 'چهار مقصد به‌هم‌پیوسته؛ یک تجربهٔ پیوسته.')}</p></div>
      <div className="lux-tool-grid">{tools.map(tool => <Link to={tool.to} className="lux-tool" key={tool.number}><div className="lux-tool-top"><Icon name={tool.icon} size={25}/><span>{tool.number}</span></div><span className="lux-tool-tag">{tool.tag}</span><h3>{tool.title}</h3><p>{tool.text}</p><span className="lux-tool-open">{t('Open workspace', 'بازکردن ابزار')}<Icon name="arrow" size={17}/></span></Link>)}</div>
    </section>
    <section className="lux-market-section"><div className="n-container">
      <div className="lux-section-title"><div><span className="lux-kicker">02 / {t('MARKET INTELLIGENCE', 'هوشمندی بازار')}</span><h2>{t('The market. In focus.', 'بازار؛ زیر نگاه تو.')}</h2></div><Link to="/markets" className="lux-line-link">{t('All markets', 'تمام بازارها')} ↗</Link></div>
      <Panel title={t('Solana market watch', 'دیده‌بان بازار سولانا')} action={<button type="button" className="n-icon-button" aria-label={t('Refresh market data', 'تازه‌سازی داده بازار')} onClick={refresh}><Icon name="refresh" size={17}/></button>}><MarketTable/></Panel>
      <p className="lux-data-note">{t('Quotes from selected Solana pools. Market observations are separate from transaction execution.', 'قیمت استخرهای منتخب سولانا؛ مشاهدهٔ بازار مستقل از اجرای تراکنش است.')}{!demo && updated && !loading ? ' · '+new Date(updated).toLocaleTimeString() : ''}</p>
    </div></section>
    <section className="n-container lux-connection-section">
      <div><span className="lux-kicker">03 / {t('CONNECTED WITH CLARITY', 'اتصال با شفافیت')}</span><h2>{t('Real network.\nVisible evidence.', 'شبکهٔ واقعی.\nمدرکِ قابل مشاهده.')}</h2><p>{t('Inspect the Solana network identity, confirmed slot and existing on-chain programs. Every status is backed by a current observation.', 'شناسهٔ شبکهٔ سولانا، اسلات تأییدشده و برنامه‌های موجود روی زنجیره را ببین. هر وضعیت به یک مشاهدهٔ فعلی متکی است.')}</p><Link className="lux-line-link" to="/network">{t('Explore network & programs', 'مشاهدهٔ شبکه و برنامه‌ها')} ↗</Link></div>
      <div className="lux-connection-card"><span className="lux-small-caps">SOLANA / MAINNET</span><div className={`lux-network-seal ${verified ? 'verified' : ''}`}><Icon name="shield" size={35}/></div><strong>{verified ? t('Network verified', 'شبکه تأیید شده') : t('Awaiting verification', 'در انتظار تأیید')}</strong><p>{t('Your public address stays yours. Signing and account trading controls are separate actions.', 'آدرس عمومی در اختیار توست. امضا و کنترل معاملات حساب، اقدام‌های جداگانه‌اند.')}</p><span className="lux-connection-line"/><small>{t('Read the chain. Keep control.', 'زنجیره را ببین. کنترل را نگه دار.')}</small></div>
    </section>
    <section className="n-container lux-final"><div><span className="lux-kicker">MONEYLAND / GSP TRADING</span><h2>{t('Your next move,\nbeautifully clear.', 'حرکت بعدی تو،\nروشن‌تر از همیشه.')}</h2></div><Button variant="primary" onClick={openWallet}>{t('Connect your wallet', 'کیف پولت را متصل کن')}<Icon name="arrow" size={19}/></Button></section>
  </>;
}
