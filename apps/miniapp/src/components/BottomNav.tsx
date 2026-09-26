import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { NAV_ITEMS } from '../lib/nav.js';
import { haptics } from '../lib/telegram.js';
import { api } from '../lib/api.js';
import { aggregatePortfolio } from '../lib/portfolio.js';
import type { PortfolioSummary } from '../lib/types.js';
import { springTransition } from '../lib/motion.js';

/**
 * Fixed bottom tab bar. The Positions badge is real data (open position
 * count from the same GET /portfolio query Home/Positions already populate —
 * react-query dedupes this against their cache, no extra network request in
 * the common case), not a placeholder counter. GET /portfolio is one summary
 * per wallet (see PortfolioSummaryList's doc comment in lib/types.ts) —
 * aggregatePortfolio sums open positions across all of them.
 */
export function BottomNav() {
  const portfolio = useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api.get<PortfolioSummary[]>('/portfolio'),
  });
  const openPositions = portfolio.data
    ? aggregatePortfolio(portfolio.data).openPositions
    : undefined;

  return (
    <nav
      className="glass fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around pb-[env(safe-area-inset-bottom)]"
      aria-label="Primary"
    >
      {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          onClick={() => haptics.tap()}
          className="flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium"
        >
          {({ isActive }) => (
            <>
              <motion.span
                className="relative flex h-8 w-8 items-center justify-center rounded-full"
                animate={{ backgroundColor: isActive ? 'rgba(34,217,122,0.16)' : 'rgba(0,0,0,0)' }}
                transition={springTransition}
              >
                <Icon
                  size={20}
                  strokeWidth={isActive ? 2.4 : 2}
                  className={isActive ? 'text-text-primary' : 'text-text-secondary'}
                />
                {to === '/positions' && !!openPositions && openPositions > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-gradient px-1 text-[10px] font-bold text-[#07090F]">
                    {openPositions > 99 ? '99+' : openPositions}
                  </span>
                )}
              </motion.span>
              <span className={isActive ? 'text-text-primary' : 'text-text-secondary'}>
                {label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
