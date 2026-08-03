import { Compass, Home, User, Wallet as WalletIcon, Layers } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Five destinations — the standard mobile bottom-nav ceiling (Binance/OKX/
 * BullX all converge on 4-5). AI Signals lives inside Discovery (tab) and
 * Profit Analytics lives inside Positions (tab); Referral/Notifications/
 * Settings hang off Profile. Notifications additionally gets its own bell
 * icon in TopBar (unread badge), the way every reference app in the brief
 * treats it as a persistent affordance rather than a nav destination.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/discovery', label: 'Discovery', icon: Compass },
  { to: '/positions', label: 'Positions', icon: Layers },
  { to: '/wallet', label: 'Wallet', icon: WalletIcon },
  { to: '/profile', label: 'Profile', icon: User },
];
