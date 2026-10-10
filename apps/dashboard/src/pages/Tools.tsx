import { Link } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.js';

const tools = [
  [
    '/copy-trading',
    'Copy trading',
    'Ranked wallet candidates, account settings and the actual execution mode.',
  ],
  ['/markets', 'Markets', 'Prices, selected assets and market activity.'],
  ['/arbitrage', 'Arbitrage terminal', 'Compare DEX quotes and observe opportunities.'],
  [
    '/flash-arbitrage',
    'Flash-loan simulator',
    'Model a route. Live flash-loan execution is unavailable.',
  ],
  [
    '/wallet',
    'Connect a wallet',
    'Connect a supported browser wallet and view its public address.',
  ],
  ['/dashboard/wallets', 'GSP wallets', 'Manage account wallets, balances and history.'],
  ['/dashboard/snipes', 'Snipe settings', 'Configure entries and exits within platform limits.'],
  [
    '/dashboard/trading-lab',
    'Trading lab',
    'Review signals and compare recorded trading decisions.',
  ],
  ['/dashboard/positions', 'Positions', 'Monitor positions and available exit controls.'],
  ['/dashboard/subscription', 'Subscription', 'Plan access, reviewed payments and receipts.'],
  ['/dashboard/referrals', 'Invite friends', 'Copy your referral link and track registrations.'],
  ['/telegram', 'Telegram', 'Open the bot and connected Telegram tools.'],
] as const;

export function Tools() {
  const { user } = useAuth();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">All tools</h1>
        <p className="mt-2 text-sm text-slate-400">
          Every tool in one place. Each trading screen shows its current availability and mode.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {tools.map(([path, title, description]) => (
          <Link key={path} to={path} className="card block transition-colors hover:border-accent">
            <h2 className="font-semibold text-white">{title} ↗</h2>
            <p className="mt-2 text-sm text-slate-400">{description}</p>
          </Link>
        ))}
        {(user?.isAdmin || user?.role === 'ADMIN') && (
          <Link className="card block border-accent" to="/dashboard/admin">
            <h2 className="font-semibold text-white">Admin Control Center ↗</h2>
            <p className="mt-2 text-sm text-slate-400">
              Feature switches, connection diagnostics, accounts, risk controls and audit history.
            </p>
          </Link>
        )}
      </div>
    </div>
  );
}
