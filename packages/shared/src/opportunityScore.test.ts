import { describe, expect, it } from 'vitest';
import { calculateOpportunityScore, type OpportunityScoreWeights } from './opportunityScore.js';

const DEFAULT_WEIGHTS: OpportunityScoreWeights = {
  safetyWeightBps: 5000,
  momentumWeightBps: 0,
  walletWeightBps: 0,
  socialWeightBps: 0,
  aiWeightBps: 5000,
};

describe('calculateOpportunityScore', () => {
  it("matches a plain weighted average when only safety+AI are present (today's real case)", () => {
    const result = calculateOpportunityScore({ safetyScore: 100, aiScore: 60 }, DEFAULT_WEIGHTS);
    expect(result.finalScore).toBeCloseTo(80, 8);
  });

  it('a component present with 0 weight contributes nothing', () => {
    const withZeroWeightMomentum = calculateOpportunityScore(
      { safetyScore: 100, aiScore: 60, momentumScore: 0 },
      DEFAULT_WEIGHTS,
    );
    const withoutMomentum = calculateOpportunityScore(
      { safetyScore: 100, aiScore: 60 },
      DEFAULT_WEIGHTS,
    );
    expect(withZeroWeightMomentum.finalScore).toBeCloseTo(withoutMomentum.finalScore, 8);
  });

  it('renormalizes cleanly over safety+AI when momentum/wallet/social are all absent', () => {
    const result = calculateOpportunityScore({ safetyScore: 80, aiScore: 40 }, DEFAULT_WEIGHTS);
    expect(result.finalScore).toBeCloseTo(60, 8);
  });

  it('renormalizes over safety alone when AI is absent (no provider configured)', () => {
    const result = calculateOpportunityScore({ safetyScore: 72 }, DEFAULT_WEIGHTS);
    expect(result.finalScore).toBeCloseTo(72, 8);
  });

  it('degenerates to a single component when every other weight is 0', () => {
    const weights: OpportunityScoreWeights = {
      safetyWeightBps: 0,
      momentumWeightBps: 10000,
      walletWeightBps: 0,
      socialWeightBps: 0,
      aiWeightBps: 0,
    };
    const result = calculateOpportunityScore(
      { safetyScore: 10, momentumScore: 55, aiScore: 90 },
      weights,
    );
    expect(result.finalScore).toBeCloseTo(55, 8);
  });

  it('returns 0 when every available component has 0 weight', () => {
    const weights: OpportunityScoreWeights = {
      safetyWeightBps: 0,
      momentumWeightBps: 5000,
      walletWeightBps: 0,
      socialWeightBps: 0,
      aiWeightBps: 0,
    };
    const result = calculateOpportunityScore({ safetyScore: 90 }, weights);
    expect(result.finalScore).toBe(0);
  });

  it('preserves the raw breakdown and the weights snapshot used', () => {
    const components = { safetyScore: 100, aiScore: 60 };
    const result = calculateOpportunityScore(components, DEFAULT_WEIGHTS);
    expect(result.breakdown).toEqual(components);
    expect(result.weightsUsed).toEqual(DEFAULT_WEIGHTS);
  });
});
