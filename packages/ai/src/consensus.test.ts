import { describe, expect, it } from 'vitest';
import type { AiScore } from '@nova/shared';
import { evaluateMultiLlmConsensus, CONSENSUS_WEIGHTS } from './consensus.js';

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

describe('evaluateMultiLlmConsensus — weighted voting (2026-07-26 redesign)', () => {
  it('weights sum to 1 across the three fixed seats', () => {
    expect(CONSENSUS_WEIGHTS.gemini + CONSENSUS_WEIGHTS.openrouter + CONSENSUS_WEIGHTS.ollama).toBe(
      1,
    );
    expect(CONSENSUS_WEIGHTS).toEqual({ gemini: 0.4, openrouter: 0.3, ollama: 0.3 });
  });

  it('is BUY when all three vote BUY and the weighted confidence clears 85', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 90, decision: 'BUY', provider: 'gemini' }),
      fakeScore({ score: 90, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 90, decision: 'BUY', provider: 'ollama' }),
    );
    expect(result.decision).toBe('BUY');
    expect(result.reasons).toEqual([]);
    expect(result.weightedConfidence).toBeCloseTo(90, 5);
    expect(result.buyVotes).toBe(3);
  });

  it('computes the weighted confidence as the exact 40/30/30 weighted average', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 100, decision: 'BUY', provider: 'gemini' }),
      fakeScore({ score: 80, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 70, decision: 'BUY', provider: 'ollama' }),
    );
    // 100*0.4 + 80*0.3 + 70*0.3 = 40 + 24 + 21 = 85
    expect(result.weightedConfidence).toBeCloseTo(85, 5);
    expect(result.decision).toBe('BUY');
  });

  it('is SKIP when the weighted confidence falls just short of 85, even with all three voting BUY (unanimous, not a disagreement)', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 100, decision: 'BUY', provider: 'gemini' }),
      fakeScore({ score: 80, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 69, decision: 'BUY', provider: 'ollama' }),
    );
    // 100*0.4 + 80*0.3 + 69*0.3 = 40 + 24 + 20.7 = 84.7
    expect(result.weightedConfidence).toBeCloseTo(84.7, 5);
    expect(result.decision).toBe('SKIP');
    expect(result.reasons).toContain('weighted_confidence_below_threshold');
  });

  it('is BUY exactly at the 85 boundary (>=, not >)', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 85, decision: 'BUY', provider: 'gemini' }),
      fakeScore({ score: 85, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 85, decision: 'BUY', provider: 'ollama' }),
    );
    expect(result.decision).toBe('BUY');
  });

  it('is SKIP (never BUY) when only one of three votes BUY, even if the weighted confidence still clears 85', () => {
    // gemini SKIP@90 (.4) + openrouter SKIP@90 (.3) + ollama BUY@100 (.3) = 36+27+30 = 93 >= 85
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 90, decision: 'SKIP', provider: 'gemini' }),
      fakeScore({ score: 90, decision: 'SKIP', provider: 'openrouter' }),
      fakeScore({ score: 100, decision: 'BUY', provider: 'ollama' }),
    );
    expect(result.weightedConfidence).toBeCloseTo(93, 5);
    expect(result.buyVotes).toBe(1);
    expect(result.decision).not.toBe('BUY');
    expect(result.reasons).toContain('insufficient_buy_votes');
  });

  it('is WATCH (not SKIP) when the buy-vote requirement fails but the three voters genuinely disagree', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 90, decision: 'SKIP', provider: 'gemini' }),
      fakeScore({ score: 90, decision: 'SKIP', provider: 'openrouter' }),
      fakeScore({ score: 100, decision: 'BUY', provider: 'ollama' }),
    );
    expect(result.decision).toBe('WATCH');
  });

  it('is SKIP (not WATCH) when all three unanimously agree BUY but still miss the weighted-confidence bar', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 50, decision: 'BUY', provider: 'gemini' }),
      fakeScore({ score: 50, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 50, decision: 'BUY', provider: 'ollama' }),
    );
    expect(result.weightedConfidence).toBeCloseTo(50, 5);
    expect(result.decision).toBe('SKIP');
  });

  it('is SKIP (never WATCH) when Gemini hard-fails, regardless of what OpenRouter/Ollama say', () => {
    const gemini = fakeScore({
      score: 0,
      decision: 'SKIP',
      flags: ['ai_call_error'],
      provider: 'gemini',
    });
    const openrouter = fakeScore({ score: 100, decision: 'BUY', provider: 'openrouter' });
    const ollama = fakeScore({ score: 100, decision: 'BUY', provider: 'ollama' });
    const result = evaluateMultiLlmConsensus(gemini, openrouter, ollama);
    expect(result.decision).toBe('SKIP');
    expect(result.reasons).toContain('gemini_failed');
    expect(result.weightedConfidence).toBe(0);
    expect(result.votes).toEqual([]);
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

  it('is SKIP when both Gemini and OpenRouter hard-fail', () => {
    const gemini = fakeScore({ score: 0, decision: 'SKIP', flags: ['ai_call_error'] });
    const openrouter = fakeScore({ score: 0, decision: 'SKIP', flags: ['ai_parse_error'] });
    const result = evaluateMultiLlmConsensus(gemini, openrouter);
    expect(result.decision).toBe('SKIP');
    expect(result.reasons).toEqual(expect.arrayContaining(['gemini_failed', 'openrouter_failed']));
  });

  describe('Ollama absence/failure never blocks a BUY on its own (fail-open degrade to 2-of-2)', () => {
    it('when ollama is omitted entirely, renormalizes to Gemini/OpenRouter only and both must vote BUY', () => {
      const result = evaluateMultiLlmConsensus(
        fakeScore({ score: 90, decision: 'BUY', provider: 'gemini' }),
        fakeScore({ score: 90, decision: 'BUY', provider: 'openrouter' }),
      );
      expect(result.decision).toBe('BUY');
      expect(result.ollamaParticipated).toBe(false);
      expect(result.ollama).toBeUndefined();
      expect(result.buyVotes).toBe(2);
      expect(result.votes).toHaveLength(2);
      // 0.4/(0.4+0.3) = 4/7, 0.3/0.7 = 3/7
      expect(result.votes.find((v) => v.provider === 'gemini')!.weight).toBeCloseTo(4 / 7, 10);
      expect(result.votes.find((v) => v.provider === 'openrouter')!.weight).toBeCloseTo(3 / 7, 10);
    });

    it('when ollama hard-fails, it is excluded from weighting/vote-counting but still reported in votes for observability', () => {
      const gemini = fakeScore({ score: 90, decision: 'BUY', provider: 'gemini' });
      const openrouter = fakeScore({ score: 90, decision: 'BUY', provider: 'openrouter' });
      const ollamaFailed = fakeScore({
        score: 0,
        decision: 'SKIP',
        flags: ['ai_call_error'],
        provider: 'ollama',
      });
      const result = evaluateMultiLlmConsensus(gemini, openrouter, ollamaFailed);
      expect(result.decision).toBe('BUY');
      expect(result.ollamaParticipated).toBe(false);
      expect(result.buyVotes).toBe(2);
      expect(result.votes).toHaveLength(3);
      const ollamaVote = result.votes.find((v) => v.provider === 'ollama')!;
      expect(ollamaVote.participated).toBe(false);
      expect(ollamaVote.weight).toBe(0);
    });

    it('an Ollama outage does not force a SKIP even when Gemini/OpenRouter alone would have disagreed — same outcome as without Ollama at all', () => {
      const gemini = fakeScore({ score: 90, decision: 'BUY', provider: 'gemini' });
      const openrouter = fakeScore({ score: 90, decision: 'SKIP', provider: 'openrouter' });
      const ollamaFailed = fakeScore({
        score: 0,
        decision: 'SKIP',
        flags: ['ai_parse_error'],
        provider: 'ollama',
      });
      const withOllama = evaluateMultiLlmConsensus(gemini, openrouter, ollamaFailed);
      const withoutOllama = evaluateMultiLlmConsensus(gemini, openrouter);
      expect(withOllama.decision).toBe(withoutOllama.decision);
      expect(withOllama.weightedConfidence).toBeCloseTo(withoutOllama.weightedConfidence, 10);
    });

    it('with only Gemini+OpenRouter participating, BOTH must vote BUY to satisfy "at least two of three"', () => {
      const result = evaluateMultiLlmConsensus(
        fakeScore({ score: 95, decision: 'BUY', provider: 'gemini' }),
        fakeScore({ score: 95, decision: 'SKIP', provider: 'openrouter' }),
      );
      expect(result.decision).not.toBe('BUY');
      expect(result.reasons).toContain('insufficient_buy_votes');
    });
  });

  it('respects custom thresholds when provided', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 60, decision: 'BUY' }),
      fakeScore({ score: 60, decision: 'BUY' }),
      undefined,
      { minWeightedConfidence: 50, minBuyVotes: 2 },
    );
    expect(result.decision).toBe('BUY');
  });

  it("does not gate on Opportunity Score at all — that is autoTrader.ts's own opt-in job downstream", () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 90, decision: 'BUY' }),
      fakeScore({ score: 90, decision: 'BUY' }),
      fakeScore({ score: 90, decision: 'BUY' }),
    );
    expect(result.decision).toBe('BUY');
  });

  it('always includes every raw AiScore result on the returned object', () => {
    const gemini = fakeScore({ score: 30, decision: 'SKIP', provider: 'gemini' });
    const openrouter = fakeScore({ score: 95, decision: 'BUY', provider: 'openrouter' });
    const ollama = fakeScore({ score: 95, decision: 'BUY', provider: 'ollama' });
    const result = evaluateMultiLlmConsensus(gemini, openrouter, ollama);
    expect(result.gemini).toBe(gemini);
    expect(result.openrouter).toBe(openrouter);
    expect(result.ollama).toBe(ollama);
  });

  it('reports votes in gemini, openrouter, ollama order for consistent logging', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 90, decision: 'BUY', provider: 'gemini' }),
      fakeScore({ score: 90, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 90, decision: 'BUY', provider: 'ollama' }),
    );
    expect(result.votes.map((v) => v.provider)).toEqual(['gemini', 'openrouter', 'ollama']);
  });
});
