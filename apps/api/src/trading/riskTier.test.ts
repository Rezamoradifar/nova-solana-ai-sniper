import { describe, expect, it } from 'vitest';
import {
  applyRiskTierSizing,
  classifyRiskTier,
  DEFAULT_RISK_TIER_AGE_THRESHOLDS,
  DEFAULT_RISK_TIER_SIZE_CONFIG,
  escalateTierForPump,
  resolvePositionSizeMultiplier,
  resolveTokenAgeMs,
} from './riskTier.js';

describe('resolveTokenAgeMs', () => {
  it('computes age from a resolved pair-creation timestamp', () => {
    const now = 1_000_000;
    expect(resolveTokenAgeMs(now, now - 60_000)).toBe(60_000);
  });

  it('fails closed to age 0 (the strictest tier) when pairCreatedAt is unresolved', () => {
    expect(resolveTokenAgeMs(1_000_000, undefined)).toBe(0);
  });

  it('never returns a negative age (clock skew safety)', () => {
    expect(resolveTokenAgeMs(1_000_000, 2_000_000)).toBe(0);
  });
});

describe('classifyRiskTier', () => {
  it('classifies 0-5min as ULTRA_EARLY (Tier A)', () => {
    expect(classifyRiskTier(0, DEFAULT_RISK_TIER_AGE_THRESHOLDS)).toBe('ULTRA_EARLY');
    expect(classifyRiskTier(4 * 60 * 1000, DEFAULT_RISK_TIER_AGE_THRESHOLDS)).toBe('ULTRA_EARLY');
  });

  it('classifies 5-15min as EARLY (Tier B)', () => {
    expect(classifyRiskTier(5 * 60 * 1000, DEFAULT_RISK_TIER_AGE_THRESHOLDS)).toBe('EARLY');
    expect(classifyRiskTier(14 * 60 * 1000, DEFAULT_RISK_TIER_AGE_THRESHOLDS)).toBe('EARLY');
  });

  it('classifies 15min+ as ESTABLISHED (Tier C)', () => {
    expect(classifyRiskTier(15 * 60 * 1000, DEFAULT_RISK_TIER_AGE_THRESHOLDS)).toBe('ESTABLISHED');
    expect(classifyRiskTier(60 * 60 * 1000, DEFAULT_RISK_TIER_AGE_THRESHOLDS)).toBe('ESTABLISHED');
  });

  it('regression: the USOH incident token (bought within ~4 minutes of first detection) would classify as ULTRA_EARLY', () => {
    expect(classifyRiskTier(3.5 * 60 * 1000, DEFAULT_RISK_TIER_AGE_THRESHOLDS)).toBe('ULTRA_EARLY');
  });
});

describe('escalateTierForPump (extreme-pump protection)', () => {
  it('bumps ESTABLISHED to EARLY', () => {
    expect(escalateTierForPump('ESTABLISHED')).toBe('EARLY');
  });

  it('bumps EARLY to ULTRA_EARLY', () => {
    expect(escalateTierForPump('EARLY')).toBe('ULTRA_EARLY');
  });

  it('leaves ULTRA_EARLY unchanged — already the strictest tier', () => {
    expect(escalateTierForPump('ULTRA_EARLY')).toBe('ULTRA_EARLY');
  });
});

describe('resolvePositionSizeMultiplier / applyRiskTierSizing', () => {
  it('ESTABLISHED at default config reproduces exactly 100% of the configured buy amount (no behavior change for mature tokens)', () => {
    expect(resolvePositionSizeMultiplier('ESTABLISHED', DEFAULT_RISK_TIER_SIZE_CONFIG)).toBe(1);
    expect(applyRiskTierSizing(0.1, 'ESTABLISHED', DEFAULT_RISK_TIER_SIZE_CONFIG)).toBe(0.1);
  });

  it("ULTRA_EARLY reduces size to the configured fraction of the user's own buyAmountSol", () => {
    expect(resolvePositionSizeMultiplier('ULTRA_EARLY', DEFAULT_RISK_TIER_SIZE_CONFIG)).toBe(0.25);
    expect(applyRiskTierSizing(0.1, 'ULTRA_EARLY', DEFAULT_RISK_TIER_SIZE_CONFIG)).toBeCloseTo(
      0.025,
    );
  });

  it('EARLY sits between ULTRA_EARLY and ESTABLISHED', () => {
    expect(resolvePositionSizeMultiplier('EARLY', DEFAULT_RISK_TIER_SIZE_CONFIG)).toBe(0.5);
    expect(applyRiskTierSizing(0.1, 'EARLY', DEFAULT_RISK_TIER_SIZE_CONFIG)).toBeCloseTo(0.05);
  });

  it('scales relative to whatever buyAmountSol the user configured — never a hardcoded absolute size', () => {
    const config = { ultraEarlySizeBps: 1000, earlySizeBps: 5000, establishedSizeBps: 10000 };
    expect(applyRiskTierSizing(1, 'ULTRA_EARLY', config)).toBeCloseTo(0.1);
    expect(applyRiskTierSizing(5, 'ULTRA_EARLY', config)).toBeCloseTo(0.5);
  });
});
