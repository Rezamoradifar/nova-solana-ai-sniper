import { describe, expect, it } from 'vitest';
import {
  bandLiquidityDepthScore,
  calculateOpportunityScore,
  type OpportunityScoreWeights,
} from './opportunityScore.js';

const DEFAULT_WEIGHTS: OpportunityScoreWeights = {
  safetyWeightBps: 5000,
  momentumWeightBps: 0,
  walletWeightBps: 0,
  socialWeightBps: 0,
  aiWeightBps: 5000,
  liquidityDepthWeightBps: 0,
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
      liquidityDepthWeightBps: 0,
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
      liquidityDepthWeightBps: 0,
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

  it('liquidityDepthScore defaults to 0 weight — inert until an operator turns it on', () => {
    const withLiquidity = calculateOpportunityScore(
      { safetyScore: 100, aiScore: 60, liquidityDepthScore: 0 },
      DEFAULT_WEIGHTS,
    );
    const without = calculateOpportunityScore({ safetyScore: 100, aiScore: 60 }, DEFAULT_WEIGHTS);
    expect(withLiquidity.finalScore).toBeCloseTo(without.finalScore, 8);
  });

  it('liquidityDepthScore contributes once its weight is raised above 0', () => {
    const weights: OpportunityScoreWeights = {
      ...DEFAULT_WEIGHTS,
      safetyWeightBps: 5000,
      aiWeightBps: 0,
      liquidityDepthWeightBps: 5000,
    };
    const result = calculateOpportunityScore(
      { safetyScore: 100, liquidityDepthScore: 40 },
      weights,
    );
    expect(result.finalScore).toBeCloseTo(70, 8);
  });
});

describe('bandLiquidityDepthScore', () => {
  it('bands real liquidity into a coarse, transparent 0-100 score', () => {
    expect(bandLiquidityDepthScore(0)).toBe(0);
    expect(bandLiquidityDepthScore(500)).toBe(10);
    expect(bandLiquidityDepthScore(5_000)).toBe(30);
    expect(bandLiquidityDepthScore(25_000)).toBe(60);
    expect(bandLiquidityDepthScore(100_000)).toBe(85);
    expect(bandLiquidityDepthScore(1_000_000)).toBe(100);
  });

  it('treats a negative or non-finite value as 0 liquidity rather than throwing', () => {
    expect(bandLiquidityDepthScore(-100)).toBe(0);
    expect(bandLiquidityDepthScore(NaN)).toBe(0);
    expect(bandLiquidityDepthScore(Infinity)).toBe(0);
  });
});
