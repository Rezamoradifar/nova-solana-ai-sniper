import { Link } from 'react-router-dom';
import { Icon } from './PublicLayout.js';

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
    icon: 'wallet' as const,
    title: 'Wallet connection',
    tag: 'YOUR ACCOUNT',
    text: 'Choose your Solana wallet, approve the connection, and view your public address.',
    route: '/wallet',
    action: 'Connect wallet',
  },
];

export function WebsiteTools() {
  return (
    <div className="website-tools" aria-label="Website tools">
      {TOOLS.map((tool) => (
        <Link className="website-tool" to={tool.route} key={tool.route}>
          <div className="website-tool-top">
            <Icon name={tool.icon} size={27} />
            <span>
              {tool.number} / {tool.tag}
            </span>
          </div>
          <h3>{tool.title}</h3>
          <p>{tool.text}</p>
          <span className="website-tool-action">{tool.action}</span>
        </Link>
      ))}
    </div>
  );
}
