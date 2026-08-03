import type { MarketingCategory } from '@nova/shared';

/** Categories where a real verified stat (see marketContext.ts) is directly
 * relevant to the post's own topic — the same set runner.ts already fetches
 * market facts for, so a stat card is only ever built from a number the post
 * text itself was also allowed to cite. */
export const STAT_ELIGIBLE_CATEGORIES: readonly MarketingCategory[] = [
  'news',
  'market_updates',
  'trending_tokens',
];

/** Categories where an AI-generated atmospheric background is attempted
 * first (when MARKETING_AI_IMAGE_ENABLED and a provider resolve) before
 * falling back to the plain vector background — feature/promo content
 * benefits most from a bespoke look; a raw stat card never needs one. */
export const AI_IMAGE_ELIGIBLE_CATEGORIES: readonly MarketingCategory[] = [
  'announcements',
  'trading_tips',
  'referral',
];

/** Short, human-readable tag shown on a TEMPLATE_HEADLINE/AI_GENERATED card
 * — one static label per category, deliberately not inferred from the post's
 * own AI-generated copy (no content-sniffing/keyword heuristics here). */
export const CATEGORY_TAG: Record<MarketingCategory, string> = {
  news: 'MARKET NEWS',
  trading_tips: 'TRADING TIP',
  market_updates: 'MARKET UPDATE',
  trending_tokens: 'TOKEN SCREENING',
  referral: 'REFERRAL PROGRAM',
  announcements: 'ANNOUNCEMENT',
};

/** Calibrated so that, blended across categories.ts's own category weights,
 * roughly 60-80% of posts end up with a visual: stat-eligible categories
 * (news/market_updates/trending_tokens, ~64% of weighted volume) attach a
 * visual whenever real data was actually available; everything else rolls
 * against this probability. See imagePolicy.test.ts's own coverage-simulation
 * test for the actual blended number this produces. */
export const HEADLINE_VISUAL_PROBABILITY = 0.4;

export interface VisualDecisionInput {
  category: MarketingCategory;
  /** Whether a real, verified number (SOL price change and/or platform
   * token-screening count) was actually fetched for this run — never
   * assumed true just because the category is stat-eligible. */
  hasStatData: boolean;
  aiImageEnabled: boolean;
}

export type VisualDecision =
  | { type: 'TEMPLATE_STAT' }
  | { type: 'TEMPLATE_HEADLINE'; attemptAiFirst: boolean }
  | { type: 'NONE' };

/**
 * Chooses between a branded stat infographic, a branded headline card
 * (optionally AI-backgrounded), or no visual at all. Pure and
 * deterministic given `random` — same testability convention as
 * categories.ts's pickNextCategory.
 */
export function decideVisualType(
  input: VisualDecisionInput,
  random: () => number = Math.random,
): VisualDecision {
  if (STAT_ELIGIBLE_CATEGORIES.includes(input.category) && input.hasStatData) {
    return { type: 'TEMPLATE_STAT' };
  }

  const attemptAiFirst =
    input.aiImageEnabled && AI_IMAGE_ELIGIBLE_CATEGORIES.includes(input.category);
  if (attemptAiFirst || random() < HEADLINE_VISUAL_PROBABILITY) {
    return { type: 'TEMPLATE_HEADLINE', attemptAiFirst };
  }

  return { type: 'NONE' };
}
