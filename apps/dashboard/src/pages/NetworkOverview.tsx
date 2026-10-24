import { Link } from 'react-router-dom';
import { useLanguage } from '../lib/LanguageContext.js';
import { useMainnet } from '../lib/MainnetContext.js';
import { SOLANA_MAINNET_GENESIS, solanaExplorer } from '../lib/mainnet.js';
import { liveCopyBuysReady } from '../neon/realReadiness.js';
import { WalletButton } from '../components/WalletUI.js';

export default function NetworkOverview() {
  const { t } = useLanguage();
  const { observation: network, copy, verified, loading, refresh } = useMainnet();
  const ready = verified && network?.tradingMode === 'LIVE' && network.workersReady && liveCopyBuysReady(copy);
  return <div className="site-container interior-page lux-network-page">
    <div className="lux-network-heading"><div><span className="lux-kicker">SOLANA / MAINNET</span><h1>{t('The network. In full view.', 'شبکه؛ با تمام جزئیات.')}</h1><p>{t('Current chain identity, program availability and execution status — in one place.', 'شناسهٔ فعلی زنجیره، دسترس‌پذیری برنامه‌ها و وضعیت اجرا؛ در یک نما.')}</p></div><button className="btn-secondary" onClick={refresh} type="button" disabled={loading} aria-busy={loading}>{loading ? t('Checking…', 'در حال بررسی…') : t('Refresh connection', 'بررسی دوبارهٔ اتصال')} ↻</button></div>
    <section className={`lux-network-proof ${verified ? 'verified' : ''}`} aria-label={t('Verified network identity', 'هویت تأییدشدهٔ شبکه')}>
      <div><span className="lux-small-caps">NETWORK IDENTITY</span><h2>{loading ? t('Checking the chain…', 'در حال بررسی زنجیره…') : verified ? t('Solana mainnet verified', 'شبکهٔ اصلی سولانا تأیید شد') : t('Mainnet connection not verified', 'اتصال شبکهٔ اصلی تأیید نشده است')}</h2><p>{verified ? t('The RPC response matches the Solana mainnet genesis hash.', 'پاسخ RPC با Genesis Hash شبکهٔ اصلی سولانا مطابقت دارد.') : t('Live figures stay unavailable until a fresh mainnet response can be verified.', 'اعداد زنده پس از دریافت و تأیید پاسخ تازهٔ شبکهٔ اصلی نمایش داده می‌شوند.')}</p></div>
      <dl><div><dt>{t('Confirmed slot', 'اسلات تأییدشده')}</dt><dd dir="ltr">{verified ? network?.slot?.toLocaleString('en-US') : '—'}</dd></div><div><dt>{t('Non-vote transactions / sec', 'تراکنش بدون رأی / ثانیه')}</dt><dd dir="ltr">{verified && network?.nonVoteTps != null ? network.nonVoteTps.toLocaleString('en-US') : '—'}</dd></div><div><dt>{t('Observed at', 'زمان مشاهده')}</dt><dd>{verified && network ? new Date(network.checkedAt).toLocaleTimeString() : '—'}</dd></div></dl>
    </section>
    <div className="lux-genesis"><span>MAINNET GENESIS HASH</span><code dir="ltr">{SOLANA_MAINNET_GENESIS}</code><span>{verified ? t('MATCHED', 'مطابقت دارد') : t('EXPECTED IDENTITY', 'شناسهٔ مورد انتظار')}</span></div>
    {network?.configurationIssue === 'wrong_network' && <p role="alert" className="lux-network-warning">{t('A configured provider returned a different chain. Its data was rejected.', 'یکی از سرویس‌های تنظیم‌شده به زنجیرهٔ دیگری پاسخ داد؛ دادهٔ آن پذیرفته نشد.')}</p>}
    <section className="lux-program-section"><div className="lux-section-title"><div><span className="lux-kicker">ON-CHAIN / PROGRAMS</span><h2>{t('Programs behind the connection.', 'برنامه‌های پشتِ اتصال.')}</h2></div><p>{t('Existing Solana programs. Read their current on-chain status.', 'برنامه‌های موجود سولانا؛ با وضعیت فعلی روی زنجیره.')}</p></div>
      <div className="lux-program-grid">{(network?.programs ?? []).map(program => <article className="lux-program" key={program.address}>
        <div><h3>{program.name}</h3><span className={verified && program.status === 'executable' ? 'verified' : ''}>{verified && program.status === 'executable' ? t('Executable', 'قابل اجرا') : t('Not verified', 'تأیید نشده')}</span></div><code dir="ltr">{program.address}</code><a href={solanaExplorer('address', program.address)} target="_blank" rel="noopener noreferrer">{t('View on Solana Explorer', 'مشاهده در مرورگر سولانا')} ↗</a>
      </article>)}</div>
      <p className="lux-data-note">{t('Executable status confirms an account exists as a program. It is not an audit, an endorsement or permission to spend your funds.', 'وضعیت قابل اجرا، وجود حساب برنامه را تأیید می‌کند؛ به معنی حسابرسی، تأیید تجاری یا اجازهٔ خرج‌کردن دارایی شما نیست.')}</p>
    </section>
    <section className="lux-execution-section"><div><span className="lux-kicker">YOUR WORKSPACE</span><h2>{t('Connection and execution.', 'اتصال و اجرا.')}</h2><p>{t('Your wallet connects to the website. Copy trading uses the account engine and its own readiness checks.', 'کیف پول به سایت متصل می‌شود. کپی‌ترید از موتور حساب و بررسی‌های آمادگی مستقل استفاده می‌کند.')}</p><WalletButton/></div><div className="lux-execution-status"><span>{t('COPY ENGINE', 'موتور کپی‌ترید')}</span><strong>{ready ? t('Live backend ready', 'موتور واقعی آماده است') : t('New buys paused', 'خرید جدید متوقف است')}</strong><small>{network?.tradingMode === 'LIVE' ? 'LIVE' : network?.tradingMode === 'PAPER' ? 'PAPER' : t('Not verified', 'تأیید نشده')}</small><Link to="/copy-trading">{t('Open copy trading', 'ورود به کپی‌ترید')} ↗</Link></div></section>
  </div>;
}
