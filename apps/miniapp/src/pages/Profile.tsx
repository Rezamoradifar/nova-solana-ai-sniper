import { NavLink } from 'react-router-dom';
import {
  Bell,
  ChevronRight,
  Clock,
  Gift,
  History as HistoryIcon,
  LogOut,
  PieChart,
  Settings as SettingsIcon,
  Shield,
  User,
  Wallet,
} from 'lucide-react';
import { useAuth } from '../lib/AuthContext.js';
import { haptics } from '../lib/telegram.js';
import { Button, Card } from '../components/ui/index.js';
import { TopBar } from '../components/TopBar.js';

const LINKS = [
  { to: '/wallet', label: 'Wallet', icon: Wallet },
  { to: '/portfolio', label: 'Portfolio', icon: PieChart },
  { to: '/history', label: 'History', icon: HistoryIcon },
  { to: '/withdraw', label: 'Withdraw', icon: Clock },
  { to: '/referral', label: 'Referral', icon: Gift },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

/**
 * Profile screen (Increment 4) — real account data from GET /auth/me (via
 * AuthContext, already fetched at sign-in). Portfolio/History/Withdraw/
 * Referral/Notifications/Settings all hang off this screen per the nav IA
 * (lib/nav.ts's doc comment) rather than taking their own bottom-nav slots.
 */
export function Profile() {
  const { user, logout } = useAuth();

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar title="Profile" subtitle="Account & settings" />

      <Card className="flex items-center gap-4 p-5 sm:p-6">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent-gradient">
          <User size={26} className="text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-text-primary">
            {user?.email ?? 'Telegram user'}
          </p>
          <div className="mt-1 flex gap-1.5">
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              {user?.role ?? 'TRADER'}
            </span>
            <span className="rounded-full bg-accent-gradient px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
              {user?.subscriptionTier ?? 'FREE'}
            </span>
          </div>
        </div>
      </Card>

      <Card className="flex flex-col divide-y divide-white/[0.06] p-0">
        {LINKS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={() => haptics.tap()}
            className="flex items-center gap-3 px-4 py-3.5 first:rounded-t-card last:rounded-b-card hover:bg-white/[0.03]"
          >
            <Icon size={18} className="text-text-secondary" />
            <span className="flex-1 text-sm font-medium text-text-primary">{label}</span>
            <ChevronRight size={16} className="text-text-secondary" />
          </NavLink>
        ))}
      </Card>

      {user?.referralCode && (
        <Card className="flex items-center gap-3 p-4">
          <Shield size={16} className="shrink-0 text-text-secondary" />
          <p className="text-xs text-text-secondary">
            Referral code{' '}
            <span className="font-mono font-semibold text-text-primary">{user.referralCode}</span>
          </p>
        </Card>
      )}

      <Button variant="secondary" onClick={logout}>
        <span className="inline-flex items-center gap-2">
          <LogOut size={16} /> Sign out
        </span>
      </Button>
    </div>
  );
}
