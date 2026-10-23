import { Link } from 'react-router-dom';
import { useLanguage } from '../lib/LanguageContext.js';
import { useMainnet } from '../lib/MainnetContext.js';

export function MainnetRibbon() {
  const { t } = useLanguage();
  const { observation, verified, loading } = useMainnet();
  return <div className="ml-mainnet-ribbon" aria-label={t('Solana network connection', 'اتصال شبکه سولانا')}>
    <div className="ml-ribbon-inner">
      <Link to="/network" className="ml-ribbon-network"><span className="ml-solana-glyph" aria-hidden="true">≋</span><strong>SOLANA</strong><span>MAINNET</span></Link>
      <span className={`ml-network-state ${verified ? 'is-verified' : ''}`} data-testid="mainnet-status">
        <i aria-hidden="true" />{loading ? t('Verifying network', 'در حال بررسی شبکه') : verified ? t('Network verified', 'شبکه تأیید شده') : t('Connection unavailable', 'اتصال در دسترس نیست')}
      </span>
      {verified && <span className="ml-ribbon-slot" dir="ltr">SLOT {observation?.slot?.toLocaleString('en-US')}</span>}
      <Link to="/network" className="ml-ribbon-proof">{t('View network', 'مشاهده شبکه')} <span aria-hidden="true">↗</span></Link>
    </div>
  </div>;
}
