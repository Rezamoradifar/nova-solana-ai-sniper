import { describe, expect, it, vi } from 'vitest';
import type { RiskFlags, TokenInfo } from '@nova/shared';
import type { AiProvider } from './provider.js';
import { scoreToken } from './riskScorer.js';

const TOKEN: TokenInfo = {
  mint: 'MintABC',
  symbol: 'RAGEGUY',
  decimals: 9,
  createdAt: '2026-07-11T00:00:00Z',
  dex: 'pumpfun',
};

const SAFE_RISK_FLAGS: RiskFlags = {
  mintAuthorityRevoked: true,
  freezeAuthorityRevoked: true,
  lpBurnedOrLocked: true,
  top10HolderPercent: 20,
  isHoneypotSuspected: false,
  liquidityUsd: 10000,
};

function fakeProvider(generateText: ReturnType<typeof vi.fn>): AiProvider {
  return { name: 'anthropic', generateText };
}

function jsonResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return JSON.stringify({
    score: 82,
    riskLevel: 'LOW',
    decision: 'BUY',
    reasons: ['looks safe'],
    warnings: [],
    ...overrides,
  });
}

describe('scoreToken', () => {
  it('returns the parsed score/riskLevel/decision/reasons/warnings on a normal successful call', async () => {
    const generateText = vi.fn().mockResolvedValue(jsonResponse());
    const result = await scoreToken(fakeProvider(generateText), TOKEN, SAFE_RISK_FLAGS);
    expect(result).toEqual({
      score: 82,
      riskLevel: 'LOW',
      decision: 'BUY',
      reasons: ['looks safe'],
      warnings: [],
      summary: 'looks safe',
      flags: ['looks safe'],
      provider: 'anthropic',
    });
  });

  it('clamps an out-of-range score into 0-100', async () => {
    const generateText = vi.fn().mockResolvedValue(jsonResponse({ score: 150 }));
    const result = await scoreToken(fakeProvider(generateText), TOKEN, SAFE_RISK_FLAGS);
    expect(result.score).toBe(100);
  });

  it('fails closed to score 0 / CRITICAL / SKIP when the response cannot be parsed as JSON', async () => {
    const generateText = vi.fn().mockResolvedValue('not json at all');
    const result = await scoreToken(fakeProvider(generateText), TOKEN, SAFE_RISK_FLAGS);
    expect(result.score).toBe(0);
    expect(result.riskLevel).toBe('CRITICAL');
    expect(result.decision).toBe('SKIP');
    expect(result.flags).toContain('ai_parse_error');
  });

  it('fails closed when riskLevel is missing or not one of the allowed enum values', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ score: 90, decision: 'BUY', riskLevel: 'SAFE' }));
    const result = await scoreToken(fakeProvider(generateText), TOKEN, SAFE_RISK_FLAGS);
    expect(result.decision).toBe('SKIP');
    expect(result.flags).toContain('ai_parse_error');
  });

  it('fails closed when decision is missing or not BUY/SKIP', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ score: 90, riskLevel: 'LOW', decision: 'MAYBE' }));
    const result = await scoreToken(fakeProvider(generateText), TOKEN, SAFE_RISK_FLAGS);
    expect(result.decision).toBe('SKIP');
    expect(result.flags).toContain('ai_parse_error');
  });

  it('fails closed when score is missing or not a number', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ riskLevel: 'LOW', decision: 'BUY' }));
    const result = await scoreToken(fakeProvider(generateText), TOKEN, SAFE_RISK_FLAGS);
    expect(result.score).toBe(0);
    expect(result.decision).toBe('SKIP');
  });

  it('defaults reasons/warnings to an empty array when the model omits them, without failing closed', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ score: 70, riskLevel: 'MEDIUM', decision: 'BUY' }));
    const result = await scoreToken(fakeProvider(generateText), TOKEN, SAFE_RISK_FLAGS);
    expect(result.reasons).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.decision).toBe('BUY');
  });

  it('regression: fails closed instead of throwing when the AI provider call itself errors', async () => {
    // Live bug: provider.generateText() wasn't wrapped in try/catch (only JSON.parse
    // was), so a timeout/rate-limit/API error threw uncaught out of scoreToken and
    // unwound through the caller's handleNewTokenLaunch pipeline, silently dropping
    // the whole launch: no token notification, no auto-buy evaluation, nothing.
    const generateText = vi.fn().mockRejectedValue(new Error('rate limited'));
    const result = await scoreToken(fakeProvider(generateText), TOKEN, SAFE_RISK_FLAGS);
    expect(result.score).toBe(0);
    expect(result.decision).toBe('SKIP');
    expect(result.flags).toContain('ai_call_error');
    expect(result.provider).toBe('anthropic');
  });

  it('never throws — the caller can always rely on scoreToken resolving', async () => {
    const generateText = vi.fn().mockRejectedValue(new Error('network unreachable'));
    await expect(
      scoreToken(fakeProvider(generateText), TOKEN, SAFE_RISK_FLAGS),
    ).resolves.toBeDefined();
  });

  it('forces decision to SKIP AND the numeric score to 0 when mint authority is not revoked, even if the model said BUY with a high score', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(jsonResponse({ decision: 'BUY', riskLevel: 'LOW', score: 95 }));
    const riskyFlags: RiskFlags = { ...SAFE_RISK_FLAGS, mintAuthorityRevoked: false };
    const result = await scoreToken(fakeProvider(generateText), TOKEN, riskyFlags);
    expect(result.decision).toBe('SKIP');
    expect(result.riskLevel).toBe('HIGH');
    // 2026-07-21 audit fix: the numeric score is now ALSO forced to 0, not left
    // untouched — decision/riskLevel alone were dead code as far as the buy
    // path was concerned (autoTrader.ts's Math.min(ruleScore, aiScore) gate
    // only ever reads the numeric score), so an inflated model score for a
    // critical-risk token could otherwise still win that gate.
    expect(result.score).toBe(0);
  });

  it('forces decision to SKIP when a honeypot is suspected, even if the model said BUY', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(jsonResponse({ decision: 'BUY', riskLevel: 'MEDIUM' }));
    const riskyFlags: RiskFlags = { ...SAFE_RISK_FLAGS, isHoneypotSuspected: true };
    const result = await scoreToken(fakeProvider(generateText), TOKEN, riskyFlags);
    expect(result.decision).toBe('SKIP');
    expect(result.riskLevel).toBe('HIGH');
  });

  it('forces decision to SKIP when LP is not burned/locked, even if the model said BUY', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(jsonResponse({ decision: 'BUY', riskLevel: 'LOW' }));
    const riskyFlags: RiskFlags = { ...SAFE_RISK_FLAGS, lpBurnedOrLocked: false };
    const result = await scoreToken(fakeProvider(generateText), TOKEN, riskyFlags);
    expect(result.decision).toBe('SKIP');
  });

  it('forces decision to SKIP when freeze authority is not revoked, even if the model said BUY', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(jsonResponse({ decision: 'BUY', riskLevel: 'LOW' }));
    const riskyFlags: RiskFlags = { ...SAFE_RISK_FLAGS, freezeAuthorityRevoked: false };
    const result = await scoreToken(fakeProvider(generateText), TOKEN, riskyFlags);
    expect(result.decision).toBe('SKIP');
  });

  it('does not downgrade an already-CRITICAL riskLevel when forcing SKIP', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(jsonResponse({ decision: 'BUY', riskLevel: 'CRITICAL' }));
    const riskyFlags: RiskFlags = { ...SAFE_RISK_FLAGS, isHoneypotSuspected: true };
    const result = await scoreToken(fakeProvider(generateText), TOKEN, riskyFlags);
    expect(result.riskLevel).toBe('CRITICAL');
  });

  it('leaves a real SKIP decision on a safe token unaffected (no critical flags to force)', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(jsonResponse({ decision: 'SKIP', riskLevel: 'MEDIUM' }));
    const result = await scoreToken(fakeProvider(generateText), TOKEN, SAFE_RISK_FLAGS);
    expect(result.decision).toBe('SKIP');
    expect(result.riskLevel).toBe('MEDIUM');
  });

  it('includes the richer real signals (holder count, price change, buy/sell activity, liquidity confidence, market cap) in the prompt when present', async () => {
    const generateText = vi.fn().mockResolvedValue(jsonResponse());
    const richFlags: RiskFlags = {
      ...SAFE_RISK_FLAGS,
      holderCount: 42,
      liquiditySource: 'dexscreener',
      priceChangeH1: 12.5,
      priceChangeH24: -3.2,
      recentBuys: 10,
      recentSells: 4,
      recentVolumeUsd: 2500,
      marketCapUsd: 123456,
    };
    await scoreToken(fakeProvider(generateText), TOKEN, richFlags);

    const prompt = generateText.mock.calls[0]![0] as string;
    expect(prompt).toContain('42');
    expect(prompt).toContain('dexscreener');
    expect(prompt).toContain('12.5');
    expect(prompt).toContain('10');
    expect(prompt).toContain('2500');
    expect(prompt).toContain('123456');
  });

  it('does not crash when the newer optional fields are absent (older/minimal RiskFlags)', async () => {
    const generateText = vi.fn().mockResolvedValue(jsonResponse({ score: 50 }));
    await expect(
      scoreToken(fakeProvider(generateText), TOKEN, SAFE_RISK_FLAGS),
    ).resolves.toMatchObject({
      score: 50,
    });
    expect(generateText.mock.calls[0]![0]).toContain('unknown');
  });
});
