import { describe, expect, it } from 'vitest';
import { buildBuyCaption, buildShareCaption } from './captions.js';
import type { BuyCardData, SellCardData } from './render.js';

function buyData(overrides: Partial<BuyCardData> = {}): BuyCardData {
  return {
    token: {
      mint: 'MintABC1111111111111111111111111',
      name: 'Rage Guy',
      symbol: 'RAGEGUY',
      dex: 'PUMPFUN',
      aiScore: 97,
    },
    entryPriceUsd: 0.0000123,
    amountSol: 0.5,
    walletPublicKey: 'WalletPubKey1111111111111111111111',
    positionId: 'pos_123',
    signature: 'sig_abc123',
    timestamp: new Date('2026-07-10T12:00:00Z'),
    ...overrides,
  };
}

function sellData(overrides: Partial<SellCardData> = {}): SellCardData {
  return {
    token: buyData().token,
    entryPriceUsd: 0.0000123,
    exitPriceUsd: 0.0000246,
    buyAmountSol: 0.5,
    sellAmountSol: 1.0,
    profitSol: 1.84,
    profitUsd: 250,
    roiPercent: 245,
    pnlPercent: 245,
    holdingTimeMs: 3_600_000,
    exitReason: 'take_profit',
    walletPublicKey: 'WalletPubKey1111111111111111111111',
    positionId: 'pos_123',
    buySignature: 'buy_sig_abc',
    sellSignature: 'sell_sig_xyz',
    ...overrides,
  };
}

describe('buildBuyCaption', () => {
  it('matches the exact requested format', () => {
    const caption = buildBuyCaption(buyData());
    expect(caption).toBe(
      '🎯 *Nova Sniper AI*\n\n' +
        'Successfully entered a new position.\n\n' +
        'Token: $RAGEGUY\n' +
        'DEX: PUMPFUN\n\n' +
        'AI Score: 97/100',
    );
  });

  it('falls back to the mint prefix when no symbol is known, and "—" when no AI score is known', () => {
    const caption = buildBuyCaption(
      buyData({ token: { mint: 'MintXYZ11111111111111111', dex: 'RAYDIUM', aiScore: undefined } }),
    );
    expect(caption).toContain('Token: MintXYZ1');
    expect(caption).toContain('AI Score: —/100');
  });

  it('escapes Markdown-significant characters in a token symbol', () => {
    const caption = buildBuyCaption(
      buyData({ token: { ...buyData().token, symbol: 'RAGE_GUY*' } }),
    );
    expect(caption).toContain('\\_');
    expect(caption).toContain('\\*');
  });
});

describe('buildShareCaption', () => {
  it('matches the exact requested format, including the bot deep link', () => {
    const caption = buildShareCaption(sellData(), 'YourBot');
    expect(caption).toBe(
      '🚀 Trade completed with Nova Sniper AI\n\n' +
        '💰 Profit: +245%\n\n' +
        '💎 +1.84 SOL\n\n' +
        '📈 ROI: +245%\n\n' +
        '🤖 AI Score: 97/100\n\n' +
        '$RAGEGUY on PUMPFUN\n\n' +
        'Trade faster with Nova Sniper AI.\n' +
        'https://t.me/YourBot',
    );
  });

  it('signs a loss with "-" and omits the AI Score line when unknown', () => {
    const caption = buildShareCaption(
      sellData({
        profitSol: -0.5,
        profitUsd: -75,
        roiPercent: -50,
        pnlPercent: -50,
        token: { ...sellData().token, aiScore: undefined },
      }),
      'YourBot',
    );
    expect(caption).toContain('Profit: -50%');
    expect(caption).toContain('-0.50 SOL');
    expect(caption).toContain('ROI: -50%');
    expect(caption).not.toContain('AI Score');
  });

  it('omits the bot link entirely when the username could not be resolved', () => {
    const caption = buildShareCaption(sellData(), undefined);
    expect(caption).not.toContain('t.me');
    expect(caption.endsWith('Trade faster with Nova Sniper AI.')).toBe(true);
  });

  it('regression: escapes a "_" in the bot username so Telegram\'s legacy Markdown parser never rejects the send', () => {
    // Live-verified failure: sendPhoto returned 400 "can't parse entities" for the
    // real bot username "Solanxaxsniper_bot" — an unescaped "_" reads as an
    // unterminated italic marker and silently kills every SELL card delivery.
    const caption = buildShareCaption(sellData(), 'Solanxaxsniper_bot');
    expect(caption).toContain('https://t.me/Solanxaxsniper\\_bot');
    expect(caption).not.toContain('https://t.me/Solanxaxsniper_bot');
  });

  it('escapes Markdown-significant characters in the token symbol too', () => {
    const caption = buildShareCaption(
      sellData({ token: { ...sellData().token, symbol: 'RAGE_GUY*' } }),
      'YourBot',
    );
    expect(caption).toContain('$RAGE\\_GUY\\*');
  });
});
