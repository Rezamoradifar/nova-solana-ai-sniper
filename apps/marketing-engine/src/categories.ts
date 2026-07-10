import type { MarketingCategory } from '@nova/shared';

export const CATEGORIES: MarketingCategory[] = [
  'news',
  'trading_tips',
  'market_updates',
  'trending_tokens',
  'referral',
  'announcements',
];

/**
 * Weighted so trading tips and market updates (the highest-value recurring
 * content) show up more often than one-off announcement/referral posts,
 * while still guaranteeing every category gets picked eventually.
 */
const WEIGHTS: Record<MarketingCategory, number> = {
  news: 3,
  trading_tips: 3,
  market_updates: 3,
  trending_tokens: 3,
  referral: 1,
  announcements: 1,
};

/**
 * Picks the next category with weighted randomness, excluding whichever
 * category was posted most recently so two posts in a row never repeat a
 * category (a cheap variety guarantee independent of content dedupe).
 */
export function pickNextCategory(
  recentCategories: MarketingCategory[],
  random: () => number = Math.random,
): MarketingCategory {
  const lastCategory = recentCategories.at(-1);
  const candidates = CATEGORIES.filter((c) => c !== lastCategory);
  const pool = candidates.length > 0 ? candidates : CATEGORIES;

  const totalWeight = pool.reduce((sum, c) => sum + WEIGHTS[c], 0);
  let roll = random() * totalWeight;

  for (const category of pool) {
    roll -= WEIGHTS[category];
    if (roll <= 0) return category;
  }
  return pool[pool.length - 1]!;
}
