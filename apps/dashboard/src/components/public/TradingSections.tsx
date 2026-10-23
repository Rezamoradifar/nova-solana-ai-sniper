import { Link } from 'react-router-dom';
import { BOT_URL } from '../../lib/publicMarket.js';
import { Icon } from './PublicLayout.js';
import { useLanguage } from '../../lib/LanguageContext.js';

export function TradingSections() {
  const { t: localize } = useLanguage();
  return (
    <section className="trading-sections" aria-label={localize('Telegram bot account sections')}>
      <div className="access-banner">
        <div>
          <Icon name="layers" size={23} />
          <span>
            <strong>{localize('Start free with GSP TRADING.')}</strong>
            <small>{localize('Upgrade in Packages for a lower fee and higher limits.')}</small>
          </span>
        </div>
        <Link className="text-link" to="/pricing">
          {localize('Explore bot packages')}
        </Link>
      </div>
      <div className="account-sections">
        {[
          {
            symbol: '👛',
            title: 'Wallets',
            text: 'View balances and manage the wallets held in your Telegram bot account.',
            action: 'Open bot · choose Wallets',
          },
          {
            symbol: '🎯',
            title: 'Snipe Configs',
            text: 'Review your active snipe configs, buy settings, and account limits.',
            action: 'Open bot · choose Snipe Configs',
          },
          {
            symbol: '📈',
            title: 'Open Positions',
            text: 'Follow your account’s positions and review their available controls.',
            action: 'Open bot · choose Positions',
          },
        ].map((section) => (
          <article className="account-section" key={section.title}>
            <span aria-hidden="true">{section.symbol}</span>
            <h3>{localize(section.title)}</h3>
            <p>{localize(section.text)}</p>
            <a className="text-link" href={BOT_URL} target="_blank" rel="noreferrer">
              {localize(section.action)}
            </a>
          </article>
        ))}
        <article className="account-section">
          <span aria-hidden="true">💎</span>
          <h3>{localize('Packages')}</h3>
          <p>
            {localize('Compare access options and confirm current fees and limits in the app.')}
          </p>
          <Link className="text-link" to="/pricing">
            {localize('Explore bot packages')}
          </Link>
        </article>
      </div>
      <p className="source-note">
        {localize(
          'Open the bot, press Start, then choose a section from its menu. Your bot account’s balances, configurations, and positions are available inside Telegram.',
        )}
      </p>
    </section>
  );
}
