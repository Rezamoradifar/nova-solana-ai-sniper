import { Bell } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useLiveEvents } from '../lib/liveEvents.js';
import { haptics } from '../lib/telegram.js';
import { BrandMark } from './BrandMark.js';

export interface TopBarProps {
  title: string;
  subtitle?: string;
}

/** Per-screen header — title + the one persistent notification affordance
 * (unread count is real, from the live WS feed; see lib/liveEvents.tsx). */
export function TopBar({ title, subtitle }: TopBarProps) {
  const { unreadCount } = useLiveEvents();

  return (
    <header className="mb-2 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <BrandMark size={38} />
        <div className="min-w-0">
          {subtitle && (
            <p className="truncate text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">
              {subtitle}
            </p>
          )}
          <h1 className="truncate text-xl font-extrabold text-text-primary sm:text-2xl">{title}</h1>
        </div>
      </div>
      <NavLink
        to="/notifications"
        onClick={() => haptics.tap()}
        className="glass relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-primary"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </NavLink>
    </header>
  );
}
