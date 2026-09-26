import { useState } from 'react';
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

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user, logout } = useAuth();
  return (
    <>
      <div className="border-b border-surface-border px-5 py-5">
        <div className="text-lg font-bold text-white">GSP Bank Sniper</div>
        <div className="text-xs text-slate-500">AI Solana Trading</div>
      </div>
      <nav className="flex-1 space-y-1 px-3 py-4">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
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
    </>
  );
}

export function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-surface">
      {/* Desktop sidebar — hidden below md, where it's replaced by the drawer below. */}
      <aside className="hidden w-60 flex-col border-r border-surface-border bg-surface-raised md:flex">
        <SidebarContent />
      </aside>

      {/* Mobile top bar with hamburger toggle — only shown below md. */}
      <div className="fixed inset-x-0 top-0 z-30 flex items-center justify-between border-b border-surface-border bg-surface-raised px-4 py-3 md:hidden">
        <div className="text-base font-bold text-white">GSP Bank Sniper</div>
        <button
          onClick={() => setMobileNavOpen(true)}
          className="rounded-lg p-2 text-slate-300 hover:bg-surface-hover"
          aria-label="Open navigation menu"
        >
          ☰
        </button>
      </div>

      {/* Mobile slide-over drawer. */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative flex h-full w-64 max-w-[80vw] flex-col bg-surface-raised shadow-xl">
            <SidebarContent onNavigate={() => setMobileNavOpen(false)} />
          </aside>
        </div>
      )}

      <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 pt-20 md:p-8 md:pt-8">
        <Outlet />
      </main>
    </div>
  );
}
