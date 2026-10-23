import { Link } from 'react-router-dom';
import { Icon, PageHeading } from '../components/public/PublicLayout.js';
import { TradingSections } from '../components/public/TradingSections.js';
import { BOT_URL } from '../lib/publicMarket.js';
import { useLanguage } from '../lib/LanguageContext.js';

export default function PublicTelegram() {
  const { t: localize } = useLanguage();
  return (
    <div className="site-container interior-page telegram-page">
      <PageHeading
        eyebrow={localize('TELEGRAM BOT')}
        title={localize('GSP TRADING. In Telegram.')}
        text={localize(
          'Manage your bot account in one place: wallets, active snipe configs, open positions, and packages.',
        )}
      >
        <a className="nova-button" href={BOT_URL} target="_blank" rel="noreferrer">
          <Icon name="telegram" size={20} />
          {localize('Open Telegram bot')}
        </a>
      </PageHeading>
      <div className="bot-welcome panel">
        <div className="bot-avatar">
          <Icon name="telegram" size={34} />
        </div>
        <div>
          <span className="eyebrow">{localize('YOUR TELEGRAM WORKSPACE')}</span>
          <h2>{localize('👋 GSP TRADING')}</h2>
          <p>
            {localize(
              'Pick a section below, or open the bot and use the menu at the bottom of the chat.',
            )}
          </p>
        </div>
        <span className="outline-tag">{localize('BOT ACCOUNT')}</span>
      </div>
      <TradingSections />
      <section className="bot-account-note">
        <Icon name="wallet" size={26} />
        <div>
          <h2>{localize('Your website wallet connection')}</h2>
          <p>
            {localize(
              'Connect a browser wallet from the website’s dedicated Wallet section. Your Telegram bot account and its server-managed wallets are managed separately.',
            )}
          </p>
        </div>
        <Link className="nova-button button-outline" to="/wallet">
          {localize('Open wallet connection')}
        </Link>
      </section>
      <div className="bot-return">
        <Link className="text-link" to="/tools">
          {localize('Explore website tools')}
        </Link>
        <Link className="text-link" to="/security">
          {localize('Review custody & security')}
        </Link>
      </div>
    </div>
  );
}
