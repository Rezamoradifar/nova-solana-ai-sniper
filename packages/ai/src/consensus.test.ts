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
    provider: 'openrouter',
    ...overrides,
  };
}

describe('evaluateMultiLlmConsensus — weighted voting (2026-07-27 redesign: Gemini removed)', () => {
  it('weights sum to 1 across the two fixed seats', () => {
    expect(CONSENSUS_WEIGHTS.openrouter + CONSENSUS_WEIGHTS.ollama).toBe(1);
    expect(CONSENSUS_WEIGHTS).toEqual({ openrouter: 0.5, ollama: 0.5 });
  });

  it('is BUY when both vote BUY and the weighted confidence clears 85', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 90, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 90, decision: 'BUY', provider: 'ollama' }),
    );
    expect(result.decision).toBe('BUY');
    expect(result.reasons).toEqual([]);
    expect(result.weightedConfidence).toBeCloseTo(90, 5);
    expect(result.buyVotes).toBe(2);
  });

  it('computes the weighted confidence as the exact 50/50 weighted average', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 100, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 70, decision: 'BUY', provider: 'ollama' }),
    );
    // 100*0.5 + 70*0.5 = 85
    expect(result.weightedConfidence).toBeCloseTo(85, 5);
    expect(result.decision).toBe('BUY');
  });

  it('is SKIP when the weighted confidence falls just short of 85, even with both voting BUY (unanimous, not a disagreement)', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 90, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 79, decision: 'BUY', provider: 'ollama' }),
    );
    // 90*0.5 + 79*0.5 = 84.5
    expect(result.weightedConfidence).toBeCloseTo(84.5, 5);
    expect(result.decision).toBe('SKIP');
    expect(result.reasons).toContain('weighted_confidence_below_threshold');
  });

  it('is BUY exactly at the 85 boundary (>=, not >)', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 85, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 85, decision: 'BUY', provider: 'ollama' }),
    );
    expect(result.decision).toBe('BUY');
  });

  it('is SKIP (never BUY) when only one of two votes BUY, even if the weighted confidence still clears 85', () => {
    // openrouter BUY@100 (.5) + ollama SKIP@90 (.5) = 50+45 = 95 >= 85
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 100, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 90, decision: 'SKIP', provider: 'ollama' }),
    );
    expect(result.weightedConfidence).toBeCloseTo(95, 5);
    expect(result.buyVotes).toBe(1);
    expect(result.decision).not.toBe('BUY');
    expect(result.reasons).toContain('insufficient_buy_votes');
  });

  it('is WATCH (not SKIP) when the buy-vote requirement fails but the two voters genuinely disagree', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 100, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 90, decision: 'SKIP', provider: 'ollama' }),
    );
    expect(result.decision).toBe('WATCH');
  });

  it('is SKIP (not WATCH) when both unanimously agree BUY but still miss the weighted-confidence bar', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 50, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 50, decision: 'BUY', provider: 'ollama' }),
    );
    expect(result.weightedConfidence).toBeCloseTo(50, 5);
    expect(result.decision).toBe('SKIP');
  });

  describe('never blocks the pipeline: one provider hard-failing/unconfigured degrades to a single-voter decision, never a forced SKIP', () => {
    it('when OpenRouter hard-fails, Ollama alone can still produce a BUY', () => {
      const openrouter = fakeScore({
        score: 0,
        decision: 'SKIP',
        flags: ['ai_call_error'],
        provider: 'openrouter',
      });
      const ollama = fakeScore({ score: 95, decision: 'BUY', provider: 'ollama' });
      const result = evaluateMultiLlmConsensus(openrouter, ollama);
      expect(result.decision).toBe('BUY');
      expect(result.openrouterParticipated).toBe(false);
      expect(result.ollamaParticipated).toBe(true);
      expect(result.weightedConfidence).toBeCloseTo(95, 5);
      expect(result.buyVotes).toBe(1);
      const orVote = result.votes.find((v) => v.provider === 'openrouter')!;
      expect(orVote.participated).toBe(false);
      expect(orVote.weight).toBe(0);
    });

    it('when Ollama hard-fails with an invalid/unparseable response, OpenRouter alone can still produce a BUY', () => {
      const openrouter = fakeScore({ score: 95, decision: 'BUY', provider: 'openrouter' });
      const ollama = fakeScore({
        score: 0,
        decision: 'SKIP',
        flags: ['ai_parse_error'],
        provider: 'ollama',
      });
      const result = evaluateMultiLlmConsensus(openrouter, ollama);
      expect(result.decision).toBe('BUY');
      expect(result.openrouterParticipated).toBe(true);
      expect(result.ollamaParticipated).toBe(false);
    });

    it('when ollama is omitted entirely, OpenRouter alone (100% weight) decides', () => {
      const result = evaluateMultiLlmConsensus(
        fakeScore({ score: 90, decision: 'BUY', provider: 'openrouter' }),
      );
      expect(result.decision).toBe('BUY');
      expect(result.ollamaParticipated).toBe(false);
      expect(result.ollama).toBeUndefined();
      expect(result.buyVotes).toBe(1);
      expect(result.votes).toHaveLength(1);
      expect(result.votes[0]!.weight).toBe(1);
    });

    it('is SKIP only when BOTH OpenRouter and Ollama hard-fail — no signal left at all', () => {
      const openrouter = fakeScore({ score: 0, decision: 'SKIP', flags: ['ai_call_error'] });
      const ollama = fakeScore({ score: 0, decision: 'SKIP', flags: ['ai_parse_error'] });
      const result = evaluateMultiLlmConsensus(openrouter, ollama);
      expect(result.decision).toBe('SKIP');
      expect(result.reasons).toEqual(
        expect.arrayContaining(['openrouter_failed', 'ollama_failed']),
      );
      expect(result.weightedConfidence).toBe(0);
      expect(result.votes).toEqual([]);
    });

    it('is SKIP when OpenRouter hard-fails and Ollama was never configured — no signal left at all', () => {
      const openrouter = fakeScore({ score: 0, decision: 'SKIP', flags: ['ai_call_error'] });
      const result = evaluateMultiLlmConsensus(openrouter);
      expect(result.decision).toBe('SKIP');
      expect(result.reasons).toEqual(['openrouter_failed']);
      expect(result.weightedConfidence).toBe(0);
    });
  });

  it('respects custom thresholds when provided', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 60, decision: 'BUY' }),
      fakeScore({ score: 60, decision: 'BUY' }),
      { minWeightedConfidence: 50, minBuyVotes: 2 },
    );
    expect(result.decision).toBe('BUY');
  });

  it("does not gate on Opportunity Score at all — that is autoTrader.ts's own opt-in job downstream", () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 90, decision: 'BUY' }),
      fakeScore({ score: 90, decision: 'BUY' }),
    );
    expect(result.decision).toBe('BUY');
  });

  it('always includes every raw AiScore result on the returned object', () => {
    const openrouter = fakeScore({ score: 95, decision: 'BUY', provider: 'openrouter' });
    const ollama = fakeScore({ score: 95, decision: 'BUY', provider: 'ollama' });
    const result = evaluateMultiLlmConsensus(openrouter, ollama);
    expect(result.openrouter).toBe(openrouter);
    expect(result.ollama).toBe(ollama);
  });

  it('reports votes in openrouter, ollama order for consistent logging', () => {
    const result = evaluateMultiLlmConsensus(
      fakeScore({ score: 90, decision: 'BUY', provider: 'openrouter' }),
      fakeScore({ score: 90, decision: 'BUY', provider: 'ollama' }),
    );
    expect(result.votes.map((v) => v.provider)).toEqual(['openrouter', 'ollama']);
  });
});
