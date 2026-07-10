import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.js';

const NAV_ITEMS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/tokens', label: 'Live Tokens' },
  { to: '/positions', label: 'Positions' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/wallets', label: 'Wallets' },
  { to: '/snipes', label: 'Snipe Settings' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/logs', label: 'Logs' },
];

export function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen bg-surface">
      <aside className="flex w-60 flex-col border-r border-surface-border bg-surface-raised">
        <div className="border-b border-surface-border px-5 py-5">
          <div className="text-lg font-bold text-white">Nova Sniper</div>
          <div className="text-xs text-slate-500">AI Solana Trading</div>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-accent text-white'
                    : 'text-slate-400 hover:bg-surface-hover hover:text-slate-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-surface-border px-5 py-4">
          <div className="mb-2 truncate text-xs text-slate-500">{user?.email ?? user?.id}</div>
          <button onClick={logout} className="btn-secondary w-full text-xs">
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-8">
        <Outlet />
      </main>
    </div>
  );
}
