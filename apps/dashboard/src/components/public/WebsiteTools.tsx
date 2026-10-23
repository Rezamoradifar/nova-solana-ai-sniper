import { Link } from 'react-router-dom';
import { Icon } from './PublicLayout.js';
import { useLanguage } from '../../lib/LanguageContext.js';

const TOOLS = [
  {
    number: '01',
    icon: 'activity' as const,
    title: 'Live markets',
    tag: 'MARKET DATA',
    text: 'Search Solana assets, compare liquidity, and explore the pools behind the price.',
    route: '/markets',
    action: 'Explore markets',
  },
  {
    number: '02',
    icon: 'scan' as const,
    title: 'Arbitrage terminal',
    tag: 'LIVE QUOTES',
    text: 'Compare cross-DEX routes, adjust cost assumptions, and inspect estimated returns.',
    route: '/arbitrage',
    action: 'Open terminal',
  },
  {
    number: '03',
    icon: 'layers' as const,
    title: 'Flash Loan Lab',
    tag: 'SIMULATION',
    text: 'Model atomic borrow, two-leg routing, repayment, and the safety gates required before live execution.',
    route: '/flash-arbitrage',
    action: 'Open flash loan lab',
  },
  {
    number: '04',
    icon: 'copy' as const,
    title: 'Copy Trading',
    tag: 'SMART MONEY',
    text: 'Rank Solana wallets, inspect GMGN Smart Money activity, and create bounded copy configurations.',
    route: '/copy-trading',
    action: 'Open copy trading',
  },
  {
    number: '05',
    icon: 'wallet' as const,
    title: 'Wallet connection',
    tag: 'YOUR ACCOUNT',
    text: 'Choose your Solana wallet, approve the connection, and view your public address.',
    route: '/wallet',
    action: 'Connect wallet',
  },
];

export function WebsiteTools() {
  const { t: localize } = useLanguage();
  return (
    <div className="website-tools" aria-label={localize('Website tools')}>
      {TOOLS.map((tool) => (
        <Link className="website-tool" to={tool.route} key={tool.route}>
          <div className="website-tool-top">
            <Icon name={tool.icon} size={27} />
            <span>
              {tool.number} / {localize(tool.tag)}
            </span>
          </div>
          <h3>{localize(tool.title)}</h3>
          <p>{localize(tool.text)}</p>
          <span className="website-tool-action">{localize(tool.action)}</span>
        </Link>
      ))}
    </div>
  );
}
