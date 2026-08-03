import { describe, expect, it } from 'vitest';
import { pickNextCategory } from '../categories.js';
import { decideVisualType, HEADLINE_VISUAL_PROBABILITY } from './imagePolicy.js';

describe('decideVisualType', () => {
  it('always chooses a stat card for a stat-eligible category with real data', () => {
    const always1 = () => 0.999; // would fail the headline-probability roll if it were consulted
    const decision = decideVisualType(
      { category: 'market_updates', hasStatData: true, aiImageEnabled: false },
      always1,
    );
    expect(decision).toEqual({ type: 'TEMPLATE_STAT' });
  });

  it('never chooses a stat card for a stat-eligible category without real data', () => {
    const decision = decideVisualType(
      { category: 'market_updates', hasStatData: false, aiImageEnabled: false },
      () => 0,
    );
    expect(decision.type).not.toBe('TEMPLATE_STAT');
  });

  it('never chooses a stat card for a non-stat-eligible category even with hasStatData true', () => {
    const decision = decideVisualType(
      { category: 'referral', hasStatData: true, aiImageEnabled: false },
      () => 0,
    );
    expect(decision.type).not.toBe('TEMPLATE_STAT');
  });

  it('rolls the headline-visual probability for a non-stat category', () => {
    const below = decideVisualType(
      { category: 'trading_tips', hasStatData: false, aiImageEnabled: false },
      () => HEADLINE_VISUAL_PROBABILITY - 0.01,
    );
    expect(below).toEqual({ type: 'TEMPLATE_HEADLINE', attemptAiFirst: false });

    const above = decideVisualType(
      { category: 'trading_tips', hasStatData: false, aiImageEnabled: false },
      () => HEADLINE_VISUAL_PROBABILITY + 0.01,
    );
    expect(above).toEqual({ type: 'NONE' });
  });

  it('always attempts a visual for an AI-eligible category when AI images are enabled, skipping the probability roll', () => {
    const decision = decideVisualType(
      { category: 'announcements', hasStatData: false, aiImageEnabled: true },
      () => 0.999,
    );
    expect(decision).toEqual({ type: 'TEMPLATE_HEADLINE', attemptAiFirst: true });
  });

  it('does not attempt AI first for an AI-eligible category when AI images are disabled', () => {
    const decision = decideVisualType(
      { category: 'announcements', hasStatData: false, aiImageEnabled: false },
      () => 0,
    );
    expect(decision.type === 'NONE' || decision.type === 'TEMPLATE_HEADLINE').toBe(true);
    if (decision.type === 'TEMPLATE_HEADLINE') expect(decision.attemptAiFirst).toBe(false);
  });

  it('never attempts AI first for a non-AI-eligible category even when AI images are enabled', () => {
    const decision = decideVisualType(
      { category: 'market_updates', hasStatData: false, aiImageEnabled: true },
      () => 0,
    );
    if (decision.type === 'TEMPLATE_HEADLINE') expect(decision.attemptAiFirst).toBe(false);
  });

  it('blended visual coverage across a realistic category mix lands in the 60-80% target range', () => {
    // Simulates 5000 scheduled posts using the real category picker (with its
    // real weights) and a fixed, plausible hasStatData rate for stat-eligible
    // categories (data fetch succeeds most of the time, not always).
    let withVisual = 0;
    const total = 5000;
    let lastCategory: ReturnType<typeof pickNextCategory> | undefined;

    for (let i = 0; i < total; i++) {
      const category = pickNextCategory(lastCategory ? [lastCategory] : []);
      lastCategory = category;
      const hasStatData = Math.random() < 0.9; // data fetch succeeds ~90% of the time
      const decision = decideVisualType({ category, hasStatData, aiImageEnabled: false });
      if (decision.type !== 'NONE') withVisual++;
    }

    const coverage = withVisual / total;
    expect(coverage).toBeGreaterThanOrEqual(0.55);
    expect(coverage).toBeLessThanOrEqual(0.85);
  });
});
