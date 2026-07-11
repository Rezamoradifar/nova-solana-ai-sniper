import { describe, expect, it } from 'vitest';
import { evaluateHardRiskGate, evaluateNotifyGate, type HardRiskSignals } from './notifyGate.js';

function goodSignals(overrides: Partial<HardRiskSignals> = {}): HardRiskSignals {
  return {
    liquidityUsd: 10_000,
    isHoneypotSuspected: false,
    freezeAuthorityRevoked: true,
    mintAuthorityRevoked: true,
    lpBurnedOrLocked: true,
    ...overrides,
  };
}

describe('evaluateHardRiskGate', () => {
  it('allows a clean token with real liquidity', () => {
    expect(evaluateHardRiskGate(goodSignals(), { minLiquidityUsd: 500 })).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it('rejects liquidity below the configured threshold, including exactly 0', () => {
    expect(
      evaluateHardRiskGate(goodSignals({ liquidityUsd: 0 }), { minLiquidityUsd: 500 }),
    ).toEqual({ allowed: false, reasons: ['liquidity_below_threshold'] });
  });

  it('rejects a suspected honeypot', () => {
    expect(
      evaluateHardRiskGate(goodSignals({ isHoneypotSuspected: true }), { minLiquidityUsd: 500 }),
    ).toEqual({ allowed: false, reasons: ['honeypot_suspected'] });
  });

  it('rejects freeze authority still enabled', () => {
    expect(
      evaluateHardRiskGate(goodSignals({ freezeAuthorityRevoked: false }), {
        minLiquidityUsd: 500,
      }),
    ).toEqual({ allowed: false, reasons: ['freeze_authority_enabled'] });
  });

  it('rejects mint risk (mint authority not revoked)', () => {
    expect(
      evaluateHardRiskGate(goodSignals({ mintAuthorityRevoked: false }), { minLiquidityUsd: 500 }),
    ).toEqual({ allowed: false, reasons: ['mint_risk'] });
  });

  it('rejects LP not locked/burned', () => {
    expect(
      evaluateHardRiskGate(goodSignals({ lpBurnedOrLocked: false }), { minLiquidityUsd: 500 }),
    ).toEqual({ allowed: false, reasons: ['lp_not_locked'] });
  });

  it('reports every failing reason at once, not just the first', () => {
    const result = evaluateHardRiskGate(
      goodSignals({ liquidityUsd: 0, isHoneypotSuspected: true, mintAuthorityRevoked: false }),
      { minLiquidityUsd: 500 },
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining(['liquidity_below_threshold', 'honeypot_suspected', 'mint_risk']),
    );
    expect(result.reasons).toHaveLength(3);
  });
});

describe('evaluateNotifyGate', () => {
  it('allows a clean token with a high enough AI score', () => {
    expect(
      evaluateNotifyGate(
        { ...goodSignals(), aiScore: 80 },
        { minLiquidityUsd: 500, minAiScore: 50 },
      ),
    ).toEqual({ allowed: true, reasons: [] });
  });

  it('rejects the exact reported production bug: liquidity 0, AI score 0, honeypot flagged', () => {
    const result = evaluateNotifyGate(
      {
        liquidityUsd: 0,
        isHoneypotSuspected: true,
        freezeAuthorityRevoked: true,
        mintAuthorityRevoked: true,
        lpBurnedOrLocked: true,
        aiScore: 0,
      },
      { minLiquidityUsd: 500, minAiScore: 50 },
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'liquidity_below_threshold',
        'honeypot_suspected',
        'ai_score_below_threshold',
      ]),
    );
  });

  it('rejects on AI score alone even when every hard risk flag is clean', () => {
    expect(
      evaluateNotifyGate(
        { ...goodSignals(), aiScore: 10 },
        { minLiquidityUsd: 500, minAiScore: 50 },
      ),
    ).toEqual({ allowed: false, reasons: ['ai_score_below_threshold'] });
  });
});
