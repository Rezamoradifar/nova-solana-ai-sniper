import { describe, expect, it } from 'vitest';
import {
  computeRiskRating,
  formatHoldingTime,
  escapeXml,
  truncateText,
  shortAddr,
  fetchLogoDataUri,
  buildBuyCardSvg,
  buildSellCardSvg,
  type BuyCardData,
  type SellCardData,
} from './render.js';

describe('escapeXml', () => {
  it('escapes all five XML-significant characters', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;',
    );
  });
});

describe('truncateText', () => {
  it('leaves short strings untouched', () => {
    expect(truncateText('abc', 10)).toBe('abc');
  });
  it('truncates and adds an ellipsis at the max length', () => {
    expect(truncateText('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('shortAddr', () => {
  it('leaves short strings untouched', () => {
    expect(shortAddr('abc123')).toBe('abc123');
  });
  it('shortens long addresses to head…tail', () => {
    expect(shortAddr('11111111111111111111111111111111')).toBe('111111…1111');
  });
});

describe('formatHoldingTime', () => {
  it('renders seconds only under a minute', () => {
    expect(formatHoldingTime(45_000)).toBe('45s');
  });
  it('renders minutes under an hour', () => {
    expect(formatHoldingTime(5 * 60_000 + 1000)).toBe('5m');
  });
  it('renders hours and minutes over an hour', () => {
    expect(formatHoldingTime(2 * 3_600_000 + 15 * 60_000)).toBe('2h 15m');
  });
});

describe('computeRiskRating', () => {
  it('is Low when every flag is clean', () => {
    expect(
      computeRiskRating({
        isHoneypotSuspected: false,
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        lpBurnedOrLocked: true,
        top10HolderPercent: 10,
      }),
    ).toEqual({ label: 'Low', color: '#22d97a' });
  });

  it('is Medium at 1-2 points (e.g. unrevoked mint authority)', () => {
    expect(computeRiskRating({ mintAuthorityRevoked: false, top10HolderPercent: 10 })).toEqual({
      label: 'Medium',
      color: '#f5b942',
    });
  });

  it('is High at 3+ points', () => {
    expect(
      computeRiskRating({
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        lpBurnedOrLocked: false,
      }).label,
    ).toBe('High');
    expect(
      computeRiskRating({ isHoneypotSuspected: true, mintAuthorityRevoked: false }).label,
    ).toBe('High');
  });

  it('a suspected honeypot alone is Medium (2 points), not automatically High', () => {
    expect(computeRiskRating({ isHoneypotSuspected: true }).label).toBe('Medium');
  });

  it('treats missing flags as unknown, not risky (no false High from absent data)', () => {
    expect(computeRiskRating({})).toEqual({ label: 'Low', color: '#22d97a' });
  });
});

describe('fetchLogoDataUri', () => {
  it('returns undefined immediately when no url is given (no network call)', async () => {
    expect(await fetchLogoDataUri(undefined)).toBeUndefined();
  });
});

function buyData(overrides: Partial<BuyCardData> = {}): BuyCardData {
  return {
    token: {
      mint: 'MintABC1111111111111111111111111',
      name: 'Rage Guy',
      symbol: 'RAGEGUY',
      dex: 'PUMPFUN',
      marketCapUsd: 67890,
      liquidityUsd: 12345,
      aiScore: 82,
      holderCount: 14,
      priceChangeH1: 12.5,
    },
    entryPriceUsd: 0.0000123,
    amountSol: 0.5,
    estimatedUsdValue: 75,
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
    profitSol: 0.5,
    profitUsd: 75,
    roiPercent: 100,
    pnlPercent: 100,
    holdingTimeMs: 3_600_000,
    exitReason: 'take_profit',
    highestProfitPercent: 120,
    lockedProfitPercent: 90,
    walletPublicKey: 'WalletPubKey1111111111111111111111',
    positionId: 'pos_123',
    buySignature: 'buy_sig_abc',
    sellSignature: 'sell_sig_xyz',
    ...overrides,
  };
}

describe('buildBuyCardSvg', () => {
  it('renders valid SVG containing the real trade fields, honest Whale Activity, and Top Holders (not "Total Holders")', () => {
    const svg = buildBuyCardSvg(buyData(), undefined);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('BUY EXECUTED');
    expect(svg).toContain('Rage Guy');
    expect(svg).toContain('$RAGEGUY');
    expect(svg).toContain('PUMPFUN');
    expect(svg).toContain('0.5000 SOL');
    expect(svg).toContain('82/100');
    expect(svg).toContain('Whale Activity');
    expect(svg).toContain('N/A');
    expect(svg).toContain('Top Holders');
    expect(svg).not.toContain('Total Holders');
  });

  it('escapes an untrusted token name/symbol instead of injecting raw markup', () => {
    const svg = buildBuyCardSvg(
      buyData({ token: { ...buyData().token, name: '<script>evil()</script>' } }),
      undefined,
    );
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('falls back to "—" for entry price when it is not a finite number', () => {
    const svg = buildBuyCardSvg(buyData({ entryPriceUsd: 0 }), undefined);
    expect(svg).toContain('Entry Price');
    expect(svg).toMatch(/Entry Price[\s\S]*?—/);
  });
});

describe('buildSellCardSvg', () => {
  it('uses the green profit theme and a "+" sign for a winning trade', () => {
    const svg = buildSellCardSvg(sellData(), undefined);
    expect(svg).toContain('#22d97a');
    expect(svg).toContain('+100.0%');
    expect(svg).toContain('+$75.00');
    expect(svg).toContain('Take Profit');
  });

  it('uses the red loss theme and a correctly-signed negative profit (regression: was missing the "-")', () => {
    const svg = buildSellCardSvg(
      sellData({
        pnlPercent: -50,
        profitSol: -0.0101,
        profitUsd: -1.5,
        roiPercent: -50,
        exitReason: 'stop_loss',
      }),
      undefined,
    );
    expect(svg).toContain('#f5433c');
    expect(svg).toContain('-50.0%');
    expect(svg).toContain('-$1.50');
    expect(svg).not.toContain('+$1.50');
    expect(svg).toContain('Stop Loss');
  });

  it('labels every non-TP/SL/trailing exit reason correctly', () => {
    expect(buildSellCardSvg(sellData({ exitReason: 'manual' }), undefined)).toContain(
      'Manual Sell',
    );
    expect(buildSellCardSvg(sellData({ exitReason: 'emergency' }), undefined)).toContain(
      'Emergency Sell',
    );
    expect(buildSellCardSvg(sellData({ exitReason: 'trailing_stop' }), undefined)).toContain(
      'Trailing Stop',
    );
  });

  it('renders "—" for highest/locked profit when not provided rather than fabricating a value', () => {
    const svg = buildSellCardSvg(
      sellData({ highestProfitPercent: undefined, lockedProfitPercent: undefined }),
      undefined,
    );
    expect(svg).toContain('Highest Profit');
    expect(svg).toContain('Locked Profit');
  });
});
