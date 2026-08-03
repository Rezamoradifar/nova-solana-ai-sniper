import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  compactUsd,
  buildTokenStatCardBrief,
  buildTokenCaptionHtml,
  buildSmartMoneyCaptionHtml,
  buildSmartMoneyStatCardBrief,
  buildBiggestWinnerCaptionHtml,
  truncateForPhotoCaption,
} from './format.js';
import type { TokenCardContext } from './format.js';
import type { SmartMoneyTradeCandidate } from './data.js';
import type { ShowcaseTrade } from '../tradeShowcase/data.js';

const NOW = new Date('2026-07-31T12:00:00Z');

function ctx(overrides: Partial<TokenCardContext> = {}): TokenCardContext {
  return {
    mint: '63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9',
    name: 'GigaChad',
    symbol: 'GIGA',
    categoryTag: 'TRENDING TOKEN',
    changePercent: 42.5,
    marketCapUsd: 1_200_000,
    liquidityUsd: 85_000,
    volumeUsd: 420_000,
    riskScore: 78,
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes the three characters Telegram HTML parse_mode treats as syntax', () => {
    expect(escapeHtml('<script>&"\'</script>')).toBe('&lt;script&gt;&amp;"\'&lt;/script&gt;');
  });
});

describe('compactUsd', () => {
  it('formats billions/millions/thousands compactly', () => {
    expect(compactUsd(2_500_000_000)).toBe('$2.50B');
    expect(compactUsd(1_200_000)).toBe('$1.20M');
    expect(compactUsd(85_000)).toBe('$85.0K');
    expect(compactUsd(420)).toBe('$420');
  });

  it('returns N/A rather than a fabricated 0 for an unknown value', () => {
    expect(compactUsd(undefined)).toBe('N/A');
  });

  it('handles a negative value', () => {
    expect(compactUsd(-1_500_000)).toBe('-$1.50M');
  });
});

describe('buildTokenStatCardBrief', () => {
  it('maps a full context into every stat card field', () => {
    const brief = buildTokenStatCardBrief(ctx());
    expect(brief).toEqual({
      tokenName: 'GigaChad',
      tokenSymbol: 'GIGA',
      changePercent: 42.5,
      changeLabel: '+42.5%',
      categoryTag: 'TRENDING TOKEN',
      status: 'LIVE',
      marketCapLabel: '$1.20M',
      liquidityLabel: '$85.0K',
      volumeLabel: '$420.0K',
      riskScoreLabel: '78/100',
    });
  });

  it('falls back to a shortened mint and N/A fields when nothing else is known', () => {
    const brief = buildTokenStatCardBrief(
      ctx({ name: undefined, symbol: undefined, changePercent: undefined, riskScore: undefined }),
    );
    expect(brief.tokenSymbol).toBe('—');
    expect(brief.changeLabel).toBe('N/A');
    expect(brief.riskScoreLabel).toBe('N/A');
  });
});

describe('buildTokenCaptionHtml', () => {
  it('includes every known field, HTML-escaped, with explorer links and the brand footer', () => {
    const html = buildTokenCaptionHtml(ctx(), '🔥 <b>TRENDING TOKEN</b>', NOW);
    expect(html).toContain('<b>Token:</b> GIGA');
    expect(html).toContain('<b>Market Cap:</b> $1200000.00');
    expect(html).toContain('DexScreener');
    expect(html).toContain('Solscan');
    expect(html).toContain('Birdeye');
    expect(html).toContain('Nova Solana AI Sniper');
  });

  it('HTML-escapes a token name containing special characters', () => {
    const html = buildTokenCaptionHtml(ctx({ name: 'A&B <Token>', symbol: undefined }), 'x', NOW);
    expect(html).toContain('A&amp;B &lt;Token&gt;');
    expect(html).not.toContain('<Token>');
  });

  it('omits a field rather than fabricating one when it is unknown', () => {
    const html = buildTokenCaptionHtml(ctx({ riskScore: undefined }), 'x', NOW);
    expect(html).not.toContain('Risk Score');
  });
});

describe('truncateForPhotoCaption', () => {
  it('leaves a short caption untouched', () => {
    expect(truncateForPhotoCaption('short')).toBe('short');
  });

  it('truncates a too-long caption while keeping the brand footer intact', () => {
    const long = 'x'.repeat(2000);
    const truncated = truncateForPhotoCaption(long);
    expect(truncated.length).toBeLessThanOrEqual(1024);
    expect(truncated).toContain('Nova Solana AI Sniper');
  });
});

describe('buildSmartMoneyCaptionHtml / buildSmartMoneyStatCardBrief', () => {
  const candidate: SmartMoneyTradeCandidate = {
    id: 'e1',
    walletAddress: '5S5RY1DK3qaX2qGNwzkZzgvvzMASwMHYQuTabYu3noNm',
    mint: '63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9',
    tokenName: 'GigaChad',
    tokenSymbol: 'GIGA',
    confidenceScore: 87,
    winRate: 71,
    medianRoiPercent: 210.5,
    entryMarketCapUsd: 300_000,
    entryAt: NOW,
  };

  it('includes wallet, confidence, win rate, and ROI history', () => {
    const html = buildSmartMoneyCaptionHtml(candidate, {
      marketCapUsd: 1_200_000,
      liquidityUsd: 85_000,
      volumeUsd: undefined,
      changePercent: undefined,
    });
    expect(html).toContain('SMART MONEY TRADE');
    expect(html).toContain('<b>Confidence:</b> 87%');
    expect(html).toContain('<b>Historical Win Rate:</b> 71%');
    expect(html).toContain('<b>Median ROI:</b> +210.5%');
  });

  it('uses the wallet confidence score as the card risk score field', () => {
    const brief = buildSmartMoneyStatCardBrief(candidate, {
      marketCapUsd: 1_200_000,
      liquidityUsd: 85_000,
      volumeUsd: undefined,
      changePercent: undefined,
    });
    expect(brief.riskScoreLabel).toBe('87/100');
    expect(brief.categoryTag).toBe('SMART MONEY TRADE');
  });
});

describe('buildBiggestWinnerCaptionHtml', () => {
  function trade(overrides: Partial<ShowcaseTrade> = {}): ShowcaseTrade {
    return {
      positionId: 'pos1',
      mint: '63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9',
      tokenName: 'GigaChad',
      tokenSymbol: 'GIGA',
      dex: 'RAYDIUM',
      buyAt: NOW,
      sellAt: NOW,
      entryPriceUsd: 0.001,
      exitPriceUsd: 0.005,
      roiPercent: 400,
      pnlUsd: 850,
      buySignature: 'buysig',
      sellSignature: 'sellsig',
      aiScore: 82,
      ...overrides,
    };
  }

  it('leads with ROI framing for a huge percentage gain', () => {
    const html = buildBiggestWinnerCaptionHtml(trade({ roiPercent: 400 }));
    expect(html).toContain('MASSIVE ROI');
  });

  it('leads with profit framing for a modest ROI but real absolute profit', () => {
    const html = buildBiggestWinnerCaptionHtml(trade({ roiPercent: 40 }));
    expect(html).toContain('BIGGEST PROFIT');
  });

  it('includes both buy and sell transaction links', () => {
    const html = buildBiggestWinnerCaptionHtml(trade());
    expect(html).toContain('solscan.io/tx/buysig');
    expect(html).toContain('solscan.io/tx/sellsig');
  });

  it('omits a signature link when the signature is unknown rather than fabricating a URL', () => {
    const html = buildBiggestWinnerCaptionHtml(trade({ buySignature: undefined }));
    expect(html).not.toContain('Buy Tx');
  });
});
