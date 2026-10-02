import { Link } from 'react-router-dom';
import { BOT_URL } from '../../lib/publicMarket.js';
import { Icon } from './PublicLayout.js';

export function TradingSections() {
  return (
    <section className="trading-sections" aria-label="GSP Bank Sniper app sections">
      <div className="access-banner">
        <div>
          <Icon name="layers" size={23} />
          <span>
            <strong>Start free. Build your perspective.</strong>
            <small>Upgrade in Packages for a lower fee and higher limits.</small>
          </span>
        </div>
        <Link className="text-link" to="/pricing">
          Explore packages ↗
        </Link>
      </div>
      <div className="account-sections">
        {[
          {
            symbol: '👛',
            title: 'Wallets',
            text: 'View balances and manage the wallets connected to your bot account.',
            action: 'Open wallets in Telegram',
          },
          {
            symbol: '🎯',
            title: 'Snipe Configs',
            text: 'Review your active snipe configs, buy settings, and account limits.',
            action: 'Open configs in Telegram',
          },
          {
            symbol: '📈',
            title: 'Open Positions',
            text: 'Follow your account’s positions and review their available controls.',
            action: 'Open positions in Telegram',
          },
        ].map((section) => (
          <article className="account-section" key={section.title}>
            <span aria-hidden="true">{section.symbol}</span>
            <h3>{section.title}</h3>
            <p>{section.text}</p>
            <a className="text-link" href={BOT_URL} target="_blank" rel="noreferrer">
              {section.action} ↗
            </a>
          </article>
        ))}
        <article className="account-section">
          <span aria-hidden="true">💎</span>
          <h3>Packages</h3>
          <p>Compare access options and confirm current fees and limits in the app.</p>
          <Link className="text-link" to="/pricing">
            Explore packages ↗
          </Link>
        </article>
      </div>
      <p className="source-note">
        Account balances and position counts are shown in your connected app. This public website
        does not display private account data.
      </p>
    </section>
  );
}
