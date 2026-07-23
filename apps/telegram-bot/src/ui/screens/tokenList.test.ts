import { InlineKeyboard } from 'grammy';
import { describe, expect, it } from 'vitest';
import type { Token } from '@prisma/client';
import { addTokenButtons, formatTokenRow, whyAccepted } from './tokenList.js';

function fakeToken(overrides: Partial<Token> = {}): Token {
  return {
    id: 't1',
    mint: '63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9',
    symbol: 'GIGA',
    name: 'GigaChad',
    decimals: 9,
    dex: 'RAYDIUM',
    poolAddress: null,
    createdAt: new Date(),
    firstSeenAt: new Date(),
    discoverySource: 'ON_CHAIN',
    telegramChannel: null,
    telegramMessageUrl: null,
    liquidityUsd: 1000,
    marketCapUsd: null,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    lpBurnedOrLocked: true,
    top10HolderPercent: 20,
    holderCount: 50,
    isHoneypotSuspected: false,
    aiScore: 80,
    aiSummary: null,
    imageUrl: null,
    ...overrides,
  } as Token;
}

describe('whyAccepted', () => {
  it('summarizes the risk flags that qualified the token', () => {
    const reason = whyAccepted(fakeToken(), 'en');
    expect(reason).toContain('mint revoked');
    expect(reason).toContain('freeze revoked');
    expect(reason).toContain('LP locked');
    expect(reason).toContain('$1000 liquidity');
    expect(reason).toContain('AI 80/100');
  });

  it('falls back to a generic message when no positive flags are present', () => {
    const reason = whyAccepted(
      fakeToken({
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        lpBurnedOrLocked: false,
        liquidityUsd: null,
        aiScore: null,
      }),
      'en',
    );
    expect(reason).toBe('passed configured thresholds');
  });
});

describe('formatTokenRow', () => {
  it('includes the Telegram source channel when discoverySource is TELEGRAM', () => {
    const text = formatTokenRow(
      fakeToken({ discoverySource: 'TELEGRAM', telegramChannel: 'trendingssol' }),
      'en',
    );
    expect(text).toContain('t.me/trendingssol');
  });

  it('omits the source line for an on-chain-detected token', () => {
    const text = formatTokenRow(fakeToken({ discoverySource: 'ON_CHAIN' }), 'en');
    expect(text).not.toContain('Source:');
  });

  it('escapes a symbol/name containing Markdown special characters', () => {
    const text = formatTokenRow(fakeToken({ symbol: 'a_b', name: 'Weird [Name]' }), 'en');
    expect(text).toContain('a\\_b');
    expect(text).toContain('Weird \\[Name\\]');
  });

  it('flags a suspected honeypot', () => {
    const text = formatTokenRow(fakeToken({ isHoneypotSuspected: true }), 'en');
    expect(text).toContain('Honeypot/rug risk flagged');
  });
});

describe('addTokenButtons', () => {
  it('adds a Chart and Buy button row for the token', () => {
    const keyboard = addTokenButtons(new InlineKeyboard(), fakeToken(), 'en');
    const row = keyboard.inline_keyboard[0]!;
    expect(row.map((b) => b.text)).toEqual(['📊 Chart', '💰 Buy']);
  });
});
