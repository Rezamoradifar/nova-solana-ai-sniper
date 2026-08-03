import { describe, it, expect, vi } from 'vitest';
import {
  decideShadowVerdict,
  recordShadowDecision,
  DEFAULT_SHADOW_MIN_AI_SCORE,
  DEFAULT_SHADOW_MIN_OPPORTUNITY_SCORE,
  type ShadowVerdictComponents,
} from './shadowModeEvaluator.js';

function components(overrides: Partial<ShadowVerdictComponents> = {}): ShadowVerdictComponents {
  return {
    safetyScore: 90,
    aiScore: 90,
    opportunityScore: 90,
    ...overrides,
  };
}

describe('decideShadowVerdict', () => {
  it('returns BUY when both thresholds are cleared', () => {
    const result = decideShadowVerdict(components());
    expect(result.decision).toBe('BUY');
    expect(result.reasons).toEqual([]);
  });

  it('always resolves to SKIP or WATCH — never BUY — when aiScore is unavailable', () => {
    const result = decideShadowVerdict(components({ aiScore: undefined }));
    expect(result.decision).not.toBe('BUY');
    expect(result.reasons).toContain('ai_score_unavailable');
  });

  it('returns SKIP for a clear miss on both thresholds', () => {
    const result = decideShadowVerdict(components({ aiScore: 10, opportunityScore: 10 }));
    expect(result.decision).toBe('SKIP');
  });

  it('returns WATCH for a near-miss just under threshold', () => {
    const result = decideShadowVerdict(
      components({
        aiScore: DEFAULT_SHADOW_MIN_AI_SCORE - 5,
        opportunityScore: DEFAULT_SHADOW_MIN_OPPORTUNITY_SCORE - 5,
      }),
    );
    expect(result.decision).toBe('WATCH');
  });

  it('respects custom thresholds', () => {
    const result = decideShadowVerdict(components({ aiScore: 50, opportunityScore: 50 }), {
      minAiScore: 40,
      minOpportunityScore: 40,
    });
    expect(result.decision).toBe('BUY');
  });
});

describe('recordShadowDecision', () => {
  it('writes exactly one row with the computed hypothetical decision', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const deps = {
      prisma: { shadowModeDecisionLog: { create } } as never,
      logger: { warn: vi.fn(), debug: vi.fn() } as never,
    };

    await recordShadowDecision(deps, {
      tokenId: 'token1',
      mint: 'mint1',
      safetyScore: 90,
      aiScore: 90,
      opportunityScore: 90,
      smartMoneyClusterBuy: false,
      sybilDiscountApplied: false,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0]![0].data;
    expect(data.mint).toBe('mint1');
    expect(data.hypotheticalDecision).toBe('BUY');
  });

  it('never throws when the DB write fails', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'));
    const warn = vi.fn();
    const deps = {
      prisma: { shadowModeDecisionLog: { create } } as never,
      logger: { warn, debug: vi.fn() } as never,
    };

    await expect(
      recordShadowDecision(deps, {
        tokenId: 'token1',
        mint: 'mint1',
        safetyScore: 90,
        opportunityScore: 90,
        smartMoneyClusterBuy: false,
        sybilDiscountApplied: false,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
