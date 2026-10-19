import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Glyph, Panel, Pill, Skeleton, productLinks, useML, useMLFeed, useWalletDialog } from './core.js';
import { money, pct } from '../lib/publicMarket.js';

const productDetails: Record<string, { en: string; fa: string; accent: string }> = {
  dex: {
    en: 'A clearer path from token discovery to swap routing.',
    fa: 'مسیر روشن‌تر از کشف توکن تا بررسی مسیر سواپ.',
    accent: 'cyan',
  },
  exchange: {
    en: 'An exchange-grade workspace for spot and futures planning.',
    fa: 'محیطی حرفه‌ای برای بررسی سفارش‌های اسپات و فیوچرز.',
    accent: 'purple',
  },
  copy: {
    en: 'Explore verified signals before copying any wallet.',
    fa: 'سیگنال‌های قابل بررسی پیش از کپی‌کردن کیف پول.',
    accent: 'cyan',
  },
  arbitrage: {
    en: 'Compare venue quotes, buffers and route freshness.',
    fa: 'مقایسه قیمت صرافی‌ها، کارمزد و تازگی مسیر.',
    accent: 'green',
  },
  memes: {
    en: 'Surface new tokens without ignoring their risks.',
    fa: 'کشف توکن‌های جدید با توجه جدی به ریسک.',
    accent: 'purple',
  },
  flash: {
    en: 'Model atomic strategies before any execution.',
    fa: 'شبیه‌سازی استراتژی‌های اتمیک قبل از اجرا.',
    accent: 'cyan',
  },
  bots: {
    en: 'Discover strategies and review safety controls.',
    fa: 'انتخاب استراتژی و بررسی تنظیمات ایمنی.',
    accent: 'green',
  },
  portfolio: {
    en: 'See connected assets and your account workspace.',
    fa: 'مشاهده دارایی‌های متصل و فضای حساب.',
    accent: 'purple',
  },
};

const landingProducts = productLinks.filter((p) => p.key !== 'overview');
const faq = [
  {
    enQ: 'Can I explore without connecting a wallet?',
    faQ: 'بدون اتصال کیف پول می‌توانم استفاده کنم؟',
    enA: 'Yes. Market research, route analysis and simulation screens are available without wallet permissions. A wallet is requested only when you choose to connect it.',
    faA: 'بله. بررسی بازار، مسیرها و شبیه‌سازی بدون مجوز کیف پول در دسترس‌اند. اتصال تنها با انتخاب خودتان انجام می‌شود.',
  },
  {
    enQ: 'Does Moneyland already execute on all five chains?',
    faQ: 'آیا مانی‌لند اکنون در پنج شبکه معامله اجرا می‌کند؟',
    enA: 'No. The existing connected services focus on Solana. Other chains and exchange-style order entry are shown as interface previews until production integrations are deployed and verified.',
    faA: 'خیر. سرویس‌های فعلی عمدتاً سولانا هستند. شبکه‌های دیگر و سفارش‌گذاری صرافی فعلاً پیش‌نمایش رابط کاربری‌اند تا اتصال واقعی آن‌ها آماده و تأیید شود.',
  },
  {
    enQ: 'Are arbitrage profits and flash loans guaranteed?',
    faQ: 'آیا سود آربیتراژ یا فلش‌لون تضمین می‌شود؟',
    enA: 'No. Different quotes are observed at different times; they do not reserve liquidity or guarantee execution. Flash-loan calculations are simulations, not live atomic transactions.',
    faA: 'خیر. قیمت‌ها در لحظه‌های مختلف دیده می‌شوند و نقدینگی را رزرو نمی‌کنند. محاسبات فلش‌لون نیز شبیه‌سازی هستند.',
  },
  {
    enQ: 'Is the platform independently audited?',
    faQ: 'آیا پلتفرم حسابرسی مستقل شده است؟',
    enA: 'An independent security audit has not been verified for this release. Review the security and custody documentation and never fund an account based solely on UI claims.',
    faA: 'برای این نسخه حسابرسی امنیتی مستقل تأیید نشده است. پیش از واریز سرمایه مستندات امنیت و نگهداری دارایی را بررسی کنید.',
  },
];

function HeroChart() {
  return <div className="ml2-hero-chart" aria-label="Illustrative trading interface visual">
    <div className="ml2-hero-chart-toolbar">
      <span><i className="ml2-dot-cyan" /> MARKET / INTELLIGENCE</span>
      <span className="ml2-hero-chart-live">ILLUSTRATIVE VISUAL</span>
    </div>
    <div className="ml2-chart-main">
      <div className="ml2-chart-axis"><span>$190</span><span>$150</span><span>$120</span><span>$80</span></div>
      <svg viewBox="0 0 620 270" preserveAspectRatio="none" role="img"
        aria-label="Decorative line chart; not actual market performance">
        <defs>
          <linearGradient id="ml2-chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#00e5ff" stopOpacity=".21"/>
            <stop offset="1" stopColor="#00e5ff" stopOpacity="0"/>
          </linearGradient>
          <linearGradient id="ml2-chart-line" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#8b5cf6"/>
            <stop offset=".64" stopColor="#00e5ff"/>
            <stop offset="1" stopColor="#22c55e"/>
          </linearGradient>
        </defs>
        <path d="M0 58H620M0 116H620M0 174H620M0 232H620" stroke="#b5d5e6" strokeOpacity=".12" strokeDasharray="4 9"/>
        <path d="M0 220L27 212L55 206L80 217L112 188L140 204L176 170L202 175L225 152L250 178L277 166L298 130L321 146L345 114L367 127L393 95L420 111L446 89L469 105L498 73L524 87L549 55L575 69L602 34L620 43L620 270L0 270Z" fill="url(#ml2-chart-fill)"/>
        <path className="ml2-chart-path" d="M0 220L27 212L55 206L80 217L112 188L140 204L176 170L202 175L225 152L250 178L277 166L298 130L321 146L345 114L367 127L393 95L420 111L446 89L469 105L498 73L524 87L549 55L575 69L602 34L620 43"
          stroke="url(#ml2-chart-line)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        <circle cx="602" cy="34" r="5" fill="#22c55e" stroke="#0a0b0f" strokeWidth="2"/>
        <circle cx="602" cy="34" r="12" stroke="#22c55e" strokeOpacity=".27"/>
      </svg>
    </div>
    <div className="ml2-chart-bottom">
      <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:59</span>
    </div>
    <div className="ml2-hero-chart-float ml2-float-one"><Glyph name="scan" size={16}/><span>Multi-venue routing</span><b>↗</b></div>
    <div className="ml2-hero-chart-float ml2-float-two"><Glyph name="shield" size={16}/><span>Risk-aware workflow</span><b>✓</b></div>
  </div>;
}

export default function MoneylandLanding() {
  const { lang, t } = useML();
  const openWallet = useWalletDialog();
  const { tokens, loading, error, updatedAt, refresh } = useMLFeed();
  const [activeSymbol, setActiveSymbol] = useState('SOL');
  const activeToken = tokens.find((token) => token.symbol === activeSymbol) || tokens[0];
  const totalVolume = tokens.reduce((sum, token) => sum + token.volume, 0);
  const totalLiquidity = tokens.reduce((sum, token) => sum + token.liquidity, 0);
  return <>
    <section className="ml2-hero-section">
      <div className="ml2-orb ml2-orb-a" aria-hidden="true" />
      <div className="ml2-orb ml2-orb-b" aria-hidden="true" />
      <div className="ml2-hero-grid-overlay" aria-hidden="true" />
      <div className="ml2-container ml2-hero-layout">
        <div className="ml2-hero-content">
          <div className="ml2-hero-badge">
            <span className="ml2-pulse-dot" />
            {lang === 'fa' ? 'نسل جدید محیط معاملاتی' : 'THE NEXT GENERATION TRADING WORKSPACE'}
            <Glyph name="arrow" size={13}/>
          </div>
          <h1 className="ml2-display">
            {lang === 'fa' ? <>تمام بازارها.<br/><span>یک محیط هوشمند.</span></> :
              <>Trade the market.<br/><span>Not the complexity.</span></>}
          </h1>
          <p className="ml2-hero-subtitle">
            {lang === 'fa'
              ? 'DEX، صرافی، کپی‌ترید، آربیتراژ، میم‌کوین، فلش‌لون و ربات‌های معاملاتی؛ از کشف فرصت تا مدیریت ریسک در یک رابط حرفه‌ای.'
              : 'DEX, exchange, copy trading, arbitrage, meme coins, flash loans and automated strategies — built into one beautifully focused command center.'}
          </p>
          <div className="ml2-hero-buttons">
            <button type="button" onClick={openWallet} className="ml2-primary-button ml2-button-xl"><Glyph name="wallet" size={19}/>{t('connect')}</button>
            <Link to="/terminal" className="ml2-outline-button ml2-button-xl">{t('startTrading')} <Glyph name="arrow" size={18}/></Link>
          </div>
          <div className="ml2-hero-proof"><span><Glyph name="shield" size={16}/>{lang === 'fa' ? 'شفافیت ریسک' : 'Risk-first tools'}</span>
            <span><Glyph name="activity" size={16}/>{lang === 'fa' ? 'داده‌های بازار سولانا' : 'Solana market observations'}</span>
            <span><Glyph name="lock" size={16}/>{lang === 'fa' ? 'تأیید کیف پول توسط کاربر' : 'User-approved wallet access'}</span></div>
        </div>
        <div className="ml2-hero-visual">
          <div className="ml2-visual-top"><span className="ml2-mono">MONEYLAND / MARKET OVERVIEW</span><Pill color="cyan"><span className="ml2-dot-cyan"/>{t('demo')}</Pill></div>
          <div className="ml2-visual-price">
            <div><span>ASSET</span><strong>SOL / USD</strong></div>
            <div><span>PRICE</span><strong dir="ltr">{tokens.find((p) => p.symbol === 'SOL') ? money(tokens.find((p) => p.symbol === 'SOL')?.price) : '—'}</strong></div>
            <div><span>24H</span><strong className="ml2-positive" dir="ltr">{tokens.find((p) => p.symbol === 'SOL') ? pct(tokens.find((p) => p.symbol === 'SOL')?.change) : '—'}</strong></div>
          </div>
          <HeroChart />
          <div className="ml2-visual-foot"><span><i className={error ? 'ml2-dot-off' : 'ml2-dot-on'}/>{error ? t('offline') : loading ? t('loading') : t('live')}</span><span className="ml2-mono">UI v2.0 • SOLANA</span></div>
        </div>
      </div>
      <div className="ml2-container ml2-hero-scroll"><span>01 / INTELLIGENT TRADING</span><span>SCROLL TO EXPLORE ↓</span></div>
    </section>

    <section className="ml2-metric-strip" aria-label="Platform data availability">
      <div className="ml2-container ml2-metric-grid">
        <div><span>{lang === 'fa' ? 'حجم ۲۴ ساعته استخرهای مشاهده‌شده' : 'Observed 24h pool volume'}</span>
          <strong dir="ltr">{tokens.length ? money(totalVolume, true) : '—'}</strong><small>Selected Solana pools</small></div>
        <div><span>{lang === 'fa' ? 'نقدینگی مشاهده‌شده (نه TVL کل)' : 'Observed liquidity (not total TVL)'}</span>
          <strong dir="ltr">{tokens.length ? money(totalLiquidity, true) : '—'}</strong><small>Selected Solana pools</small></div>
        <div><span>{lang === 'fa' ? 'کاربران فعال' : 'Active platform users'}</span>
          <strong>—</strong><small>{t('notAvailable')}</small></div>
        <div><span>{lang === 'fa' ? 'معاملات انجام‌شده' : 'Executed platform trades'}</span>
          <strong>—</strong><small>{t('notAvailable')}</small></div>
      </div>
    </section>

    <section className="ml2-container ml2-section" id="products">
      <div className="ml2-section-head">
        <div><span className="ml2-eyebrow"><span/> 02 / THE ECOSYSTEM</span>
          <h2>{lang === 'fa' ? <>هر استراتژی.<br/><em>یک خانه.</em></> : <>Every strategy.<br/><em>One destination.</em></>}</h2>
          <p>{t('bridgeText')}</p></div>
        <Link className="ml2-text-link" to="/terminal">{t('viewTools')} <Glyph name="arrow" size={17}/></Link>
      </div>
      <div className="ml2-product-grid">
        {landingProducts.map((p, i) => {
          const item = productDetails[p.key] ?? { en: p.hint, fa: p.hint, accent: 'cyan' };
          return <Link to={p.route} key={p.key} className={'ml2-product-card ml2-accent-' + item.accent}>
            <div className="ml2-product-card-head"><span className="ml2-product-icon"><Glyph name={p.icon} size={24}/></span><span className="ml2-mono">0{i + 1} / 08</span></div>
            <div className="ml2-product-card-body"><h3>{t(p.key)}</h3><p>{lang === 'fa' ? item.fa : item.en}</p></div>
            <div className="ml2-product-card-tail"><span>{t('learnMore')}</span><span className="ml2-product-arrow">↗</span></div>
          </Link>;
        })}
      </div>
    </section>

    <section className="ml2-section ml2-feature-surface">
      <div className="ml2-container">
        <div className="ml2-section-head">
          <div><span className="ml2-eyebrow"><span/> 03 / MARKET PULSE</span>
            <h2>{lang === 'fa' ? <>دید بهتر.<br/><em>تصمیم بهتر.</em></> : <>See the signal.<br/><em>Not the noise.</em></>}</h2>
            <p>{lang === 'fa' ? 'جدول بازار با داده‌های واقعی استخرهای بازگشتی از API و نمایش شفاف قطعی سرویس.' : 'Real market observations from the connected Solana data gateway — with no invented prices when the feed drops.'}</p></div>
          <button type="button" className="ml2-outline-button ml2-refresh-button" disabled={loading} onClick={refresh}>
            <Glyph name="refresh" size={16}/>{t('refresh')}</button>
        </div>
        <div className="ml2-market-showcase">
          <Panel className="ml2-market-table-panel">
            <div className="ml2-panel-heading"><h2>{lang === 'fa' ? 'دیده‌بان بازار' : 'Market watchlist'}</h2>
              <Pill color={error ? 'red' : 'green'}><span className="ml2-pulse-dot"/>{error ? t('offline') : t('live')}</Pill></div>
            <div className="ml2-table-wrap"><table className="ml2-table"><thead><tr><th>ASSET</th><th>PRICE</th><th>24H</th><th>LIQUIDITY</th><th>VOLUME</th><th></th></tr></thead>
              <tbody>{tokens.slice(0, 6).map((token) => <tr key={token.mint} className={activeToken?.mint === token.mint ? 'ml2-selected-row' : ''}>
                <td><button className="ml2-token-button" onClick={() => setActiveSymbol(token.symbol)} type="button">
                  <span className="ml2-token-avatar">{token.symbol.slice(0, 1)}</span><span><strong>{token.symbol}</strong><small>{token.name}</small></span>
                </button></td>
                <td className="ml2-mono" dir="ltr">{money(token.price)}</td>
                <td className={token.change != null && token.change < 0 ? 'ml2-negative ml2-mono' : 'ml2-positive ml2-mono'} dir="ltr">{pct(token.change)}</td>
                <td className="ml2-mono" dir="ltr">{money(token.liquidity, true)}</td>
                <td className="ml2-mono" dir="ltr">{money(token.volume, true)}</td>
                <td><button type="button" aria-label={'Inspect ' + token.symbol} className="ml2-icon-button" onClick={() => setActiveSymbol(token.symbol)}>↗</button></td>
              </tr>)}</tbody></table></div>
            {loading && !tokens.length ? <Skeleton lines={4}/> : !tokens.length ?
              <div className="ml2-empty"><Glyph name="activity" size={25}/><strong>{t('offline')}</strong><p>{error || 'No market observations returned.'}</p></div> : null}
            <div className="ml2-table-foot"><span>{updatedAt ? t('update') + ': ' + new Date(updatedAt).toLocaleTimeString() : t('loading')}</span>
              <Link to="/markets">{t('viewMarkets')} ↗</Link></div>
          </Panel>
          <Panel className="ml2-market-side">
            <div className="ml2-panel-heading"><h2>{activeToken?.symbol || 'SOL'} / USD</h2><Pill color="cyan">{t('observed')}</Pill></div>
            <div className="ml2-side-price" dir="ltr">{activeToken ? money(activeToken.price) : '—'}
              {activeToken && <small className={activeToken.change != null && activeToken.change < 0 ? 'ml2-negative' : 'ml2-positive'}>{pct(activeToken.change)} / 24H</small>}
            </div>
            <div className="ml2-mini-market-vis"><HeroChart /></div>
            <div className="ml2-side-stat"><span>OBSERVED LIQUIDITY</span><strong dir="ltr">{activeToken ? money(activeToken.liquidity, true) : '—'}</strong></div>
            <div className="ml2-side-stat"><span>24H POOL VOLUME</span><strong dir="ltr">{activeToken ? money(activeToken.volume, true) : '—'}</strong></div>
            <Link className="ml2-primary-button ml2-full-width" to="/terminal/dex">{t('startTrading')} <Glyph name="arrow" size={16}/></Link>
            <p className="ml2-muted-small">{lang === 'fa' ? 'نمودار کناری صرفاً تصویری است؛ قیمت‌ها از داده واقعی می‌آیند.' : 'Chart artwork is illustrative; observed market prices are sourced from the API.'}</p>
          </Panel>
        </div>
      </div>
    </section>

    <section className="ml2-container ml2-section">
      <div className="ml2-feature-split">
        <div><span className="ml2-eyebrow"><span/> 04 / TRADE SMARTER</span>
          <h2>{lang === 'fa' ? <>یک نگاه.<br/><em>کنترل کامل‌تر.</em></> : <>Built for precision.<br/><em>Designed for control.</em></>}</h2>
          <p>{lang === 'fa' ? 'از رصد نقدینگی و مسیرهای معاملاتی تا مدیریت سفارش و سرمایه؛ همه قابلیت‌ها کنار هم، بدون پنهان‌کردن محدودیت‌ها.' : 'Go from discovery to research, planning and connected workflows. Transparent status indicators separate working endpoints from UI-only previews.'}</p>
          <div className="ml2-vertical-features">
            <div><span><Glyph name="scan" size={20}/></span><strong>{lang === 'fa' ? 'تحلیل قبل از اجرا' : 'Research before execution'}</strong><small>{lang === 'fa' ? 'مقایسه مسیر، هزینه و زمان' : 'Route, costs and observation age'}</small></div>
            <div><span><Glyph name="shield" size={20}/></span><strong>{lang === 'fa' ? 'ریسک شفاف' : 'Clarity on risk'}</strong><small>{lang === 'fa' ? 'تفکیک دمو و داده زنده' : 'Live, estimated and simulated states'}</small></div>
            <div><span><Glyph name="layers" size={20}/></span><strong>{lang === 'fa' ? 'رابط واحد' : 'One cohesive workflow'}</strong><small>{lang === 'fa' ? 'از دسکتاپ تا موبایل' : 'Responsive from desktop to mobile'}</small></div>
          </div>
          <Link to="/terminal" className="ml2-primary-button">{t('launch')} <Glyph name="arrow" size={17}/></Link>
        </div>
        <div className="ml2-feature-illustration">
          <div className="ml2-feature-glow" />
          <div className="ml2-feature-node ml2-feature-node-a"><Glyph name="chart" size={19}/><span>DEX MARKET DATA</span><i className="ml2-pulse-dot" /></div>
          <div className="ml2-feature-node ml2-feature-node-b"><Glyph name="scan" size={19}/><span>QUOTE ANALYSIS</span><i className="ml2-pulse-dot" /></div>
          <div className="ml2-feature-node ml2-feature-node-c"><Glyph name="shield" size={19}/><span>RISK CHECKS</span><i className="ml2-pulse-dot" /></div>
          <div className="ml2-feature-center"><span>ML</span><strong>ONE<br/>WORKSPACE</strong></div>
          <div className="ml2-feature-rings" aria-hidden="true"/>
          <span className="ml2-feature-deco">MONEYLAND / INTELLIGENCE NETWORK</span>
        </div>
      </div>
    </section>

    <section className="ml2-trust-band">
      <div className="ml2-container">
        <span className="ml2-eyebrow"><span/> 05 / TRANSPARENT FOUNDATIONS</span>
        <div className="ml2-trust-row">
          <div><Glyph name="shield" size={26}/><strong>{lang === 'fa' ? 'وضعیت امنیت' : 'Security transparency'}</strong>
            <p>{t('notAudited')}</p></div>
          <div><Glyph name="activity" size={26}/><strong>{lang === 'fa' ? 'منابع داده' : 'Market data sources'}</strong>
            <p>DEX Screener · Jupiter · Solana</p></div>
          <div><Glyph name="lock" size={26}/><strong>{lang === 'fa' ? 'کنترل کاربران' : 'User-approved access'}</strong>
            <p>{lang === 'fa' ? 'مجوز کیف پول فقط با تأیید کاربر' : 'Wallet access is requested, never assumed'}</p></div>
        </div>
      </div>
    </section>

    <section className="ml2-container ml2-section ml2-faq-section">
      <div><span className="ml2-eyebrow"><span/> 06 / QUESTIONS & ANSWERS</span>
        <h2>{lang === 'fa' ? <>جزئیات مهم.<br/><em>پاسخ روشن.</em></> : <>Good questions.<br/><em>Clear answers.</em></>}</h2>
        <p>{t('riskNote')}</p>
        <Link className="ml2-text-link" to="/security">{t('security')} <Glyph name="arrow" size={17}/></Link>
      </div>
      <div className="ml2-faq-list">{faq.map((item, i) => <details key={i}>
        <summary><span>{lang === 'fa' ? item.faQ : item.enQ}</span><Glyph name="plus" size={19}/></summary>
        <p>{lang === 'fa' ? item.faA : item.enA}</p>
      </details>)}</div>
    </section>
    <section className="ml2-container ml2-last-cta">
      <div className="ml2-last-glow" aria-hidden="true"/>
      <div><Pill color="cyan">MONEYLAND / WORKSPACE V2</Pill>
        <h2>{t('readyToExplore')}</h2><p>{t('bridgeText')}</p></div>
      <div className="ml2-last-buttons"><Link to="/terminal" className="ml2-primary-button ml2-button-xl">{t('launch')} <Glyph name="arrow" size={17}/></Link>
        <button type="button" onClick={openWallet} className="ml2-outline-button ml2-button-xl"><Glyph name="wallet" size={18}/>{t('connect')}</button></div>
    </section>
  </>;
}
