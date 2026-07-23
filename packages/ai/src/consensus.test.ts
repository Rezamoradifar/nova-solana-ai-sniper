import { describe, expect, it } from 'vitest';
import type { AiScore } from '@nova/shared';
import { evaluateMultiLlmConsensus } from './consensus.js';

function fakeScore(overrides: Partial<AiScore> = {}): AiScore {
  return {
    score: 90,
    riskLevel: 'LOW',
    decision: 'BUY',
    reasons: [],
    warnings: [],
    summary: 'looks good',
    flags: [],
    provider: 'gemini',
    ...overrides,
  };
}

describe('evaluateMultiLlmConsensus', () => {
  it('is BUY when both providers recommend BUY and both scores >=80', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 85, provider: 'gemini' }),
      fakeScore({ score: 82, provider: 'openrouter' }),
    );
    expect(result).toMatchObject({ decision: 'BUY', reasons: [] });
  });

  it('is BUY exactly at the 80/80 boundary (>=, not >)', () => {
    const result = evaluateMultiLlmConsensus(fakeScore({ score: 80 }), fakeScore({ score: 80 }));
    expect(result.decision).toBe('BUY');
  });

  it('is SKIP (never WATCH) when Gemini hard-fails even though OpenRouter says BUY with a perfect score', () => {
    const gemini = fakeScore({
      score: 0,
      decision: 'SKIP',
      flags: ['ai_call_error'],
      provider: 'gemini',
    });
    const openrouter = fakeScore({ score: 100, decision: 'BUY', provider: 'openrouter' });
    const result = evaluateMultiLlmConsensus(gemini, openrouter);
    expect(result.decision).toBe('SKIP');
    expect(result.reasons).toContain('gemini_failed');
  });

  it('is SKIP (never WATCH) when OpenRouter hard-fails with an invalid/unparseable response', () => {
    const gemini = fakeScore({ score: 95, decision: 'BUY', provider: 'gemini' });
    const openrouter = fakeScore({
      score: 0,
      decision: 'SKIP',
      flags: ['ai_parse_error'],
      provider: 'openrouter',
    });
    const result = evaluateMultiLlmConsensus(gemini, openrouter);
    expect(result.decision).toBe('SKIP');
    expect(result.reasons).toContain('openrouter_failed');
    expect(result.reasons).not.toContain('gemini_failed');
  });

  it('is SKIP when both hard-fail', () => {
    const gemini = fakeScore({ score: 0, decision: 'SKIP', flags: ['ai_call_error'] });
    const openrouter = fakeScore({ score: 0, decision: 'SKIP', flags: ['ai_parse_error'] });
    const result = evaluateMultiLlmConsensus(gemini, openrouter);
    expect(result.decision).toBe('SKIP');
    expect(result.reasons).toEqual(expect.arrayContaining(['gemini_failed', 'openrouter_failed']));
  });

  it('is WATCH on a genuine disagreement between two completed, non-failed calls', () => {
    const gemini = fakeScore({ score: 95, decision: 'BUY', provider: 'gemini' });
    const openrouter = fakeScore({ score: 95, decision: 'SKIP', provider: 'openrouter' });
    const result = evaluateMultiLlmConsensus(gemini, openrouter);
    expect(result.decision).toBe('WATCH');
    expect(result.reasons).toContain('openrouter_decision_not_buy');
  });

  it('is SKIP (not WATCH) when both agree BUY but one score is below threshold', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 79, decision: 'BUY' }),
      fakeScore({ score: 95, decision: 'BUY' }),
    );
    expect(result.decision).toBe('SKIP');
    expect(result.reasons).toContain('gemini_score_below_threshold');
  });

  it('respects a custom minAiScore threshold when provided', () => {
    const result = evaluateMultiLlmConsensus(fakeScore({ score: 60 }), fakeScore({ score: 60 }), {
      minAiScore: 50,
    });
    expect(result.decision).toBe('BUY');
  });

  it("does not gate on Opportunity Score at all — that is autoTrader.ts's own opt-in job downstream (2026-07-22 audit)", () => {
    // Both providers agree BUY with strong scores; no opportunityScore argument
    // exists anymore. A token with a terrible Opportunity Score must still
    // reach BUY here — autoTrader.ts's per-config, double-opt-in gate is the
    // only place that score is ever allowed to block a trade.
    const result = evaluateMultiLlmConsensus(fakeScore({ score: 90 }), fakeScore({ score: 90 }));
    expect(result.decision).toBe('BUY');
  });

  it('always includes both raw AiScore results on the returned object', () => {
    const gemini = fakeScore({ score: 30, decision: 'SKIP', provider: 'gemini' });
    const openrouter = fakeScore({ score: 95, decision: 'BUY', provider: 'openrouter' });
    const result = evaluateMultiLlmConsensus(gemini, openrouter);
    expect(result.gemini).toBe(gemini);
    expect(result.openrouter).toBe(openrouter);
  });
});
