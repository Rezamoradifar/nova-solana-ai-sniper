import { Link } from 'react-router-dom';
import { BOT_URL } from '../../lib/publicMarket.js';
import { Icon } from './PublicLayout.js';

export function TradingSections() {
  return (
    <section className="trading-sections" aria-label="Telegram bot account sections">
      <div className="access-banner">
        <div>
          <Icon name="layers" size={23} />
          <span>
            <strong>Start free with GSP TRADEING.</strong>
            <small>Upgrade in Packages for a lower fee and higher limits.</small>
          </span>
        </div>
        <Link className="text-link" to="/pricing">
          Explore bot packages
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
            <h3>{section.title}</h3>
            <p>{section.text}</p>
            <a className="text-link" href={BOT_URL} target="_blank" rel="noreferrer">
              {section.action}
            </a>
          </article>
        ))}
        <article className="account-section">
          <span aria-hidden="true">💎</span>
          <h3>Packages</h3>
          <p>Compare access options and confirm current fees and limits in the app.</p>
          <Link className="text-link" to="/pricing">
            Explore bot packages
          </Link>
        </article>
      </div>
      <p className="source-note">
        Open the bot, press Start, then choose a section from its menu. Your bot account’s balances,
        configurations, and positions are available inside Telegram.
      </p>
    </section>
  );
}
