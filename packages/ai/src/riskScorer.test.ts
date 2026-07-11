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

const RISK_FLAGS: RiskFlags = {
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

describe('scoreToken', () => {
  it('returns the parsed score/summary/flags on a normal successful call', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ score: 82, summary: 'Looks safe', flags: ['ok'] }));
    const result = await scoreToken(fakeProvider(generateText), TOKEN, RISK_FLAGS);
    expect(result).toEqual({
      score: 82,
      summary: 'Looks safe',
      flags: ['ok'],
      provider: 'anthropic',
    });
  });

  it('clamps an out-of-range score into 0-100', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ score: 150, summary: 'x', flags: [] }));
    const result = await scoreToken(fakeProvider(generateText), TOKEN, RISK_FLAGS);
    expect(result.score).toBe(100);
  });

  it('fails closed to score 0 when the response cannot be parsed as JSON', async () => {
    const generateText = vi.fn().mockResolvedValue('not json at all');
    const result = await scoreToken(fakeProvider(generateText), TOKEN, RISK_FLAGS);
    expect(result.score).toBe(0);
    expect(result.flags).toContain('ai_parse_error');
  });

  it('regression: fails closed to score 0 instead of throwing when the AI provider call itself errors', async () => {
    // Live bug: provider.generateText() wasn't wrapped in try/catch (only JSON.parse
    // was), so a timeout/rate-limit/API error threw uncaught out of scoreToken and
    // unwound through the caller's handleNewTokenLaunch pipeline, silently dropping
    // the whole launch: no token notification, no auto-buy evaluation, nothing.
    const generateText = vi.fn().mockRejectedValue(new Error('rate limited'));
    const result = await scoreToken(fakeProvider(generateText), TOKEN, RISK_FLAGS);
    expect(result.score).toBe(0);
    expect(result.flags).toContain('ai_call_error');
    expect(result.provider).toBe('anthropic');
  });

  it('never throws — the caller can always rely on scoreToken resolving', async () => {
    const generateText = vi.fn().mockRejectedValue(new Error('network unreachable'));
    await expect(scoreToken(fakeProvider(generateText), TOKEN, RISK_FLAGS)).resolves.toBeDefined();
  });

  it('includes the richer real signals (holder count, price change, buy/sell activity, liquidity confidence) in the prompt when present', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ score: 70, summary: 'ok', flags: [] }));
    const richFlags: RiskFlags = {
      ...RISK_FLAGS,
      holderCount: 42,
      liquiditySource: 'dexscreener',
      priceChangeH1: 12.5,
      priceChangeH24: -3.2,
      recentBuys: 10,
      recentSells: 4,
      recentVolumeUsd: 2500,
    };
    await scoreToken(fakeProvider(generateText), TOKEN, richFlags);

    const prompt = generateText.mock.calls[0]![0] as string;
    expect(prompt).toContain('42');
    expect(prompt).toContain('dexscreener');
    expect(prompt).toContain('12.5');
    expect(prompt).toContain('10');
    expect(prompt).toContain('2500');
  });

  it('does not crash when the newer optional fields are absent (older/minimal RiskFlags)', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ score: 50, summary: 'ok', flags: [] }));
    await expect(scoreToken(fakeProvider(generateText), TOKEN, RISK_FLAGS)).resolves.toMatchObject({
      score: 50,
    });
    expect(generateText.mock.calls[0]![0]).toContain('unknown');
  });
});
