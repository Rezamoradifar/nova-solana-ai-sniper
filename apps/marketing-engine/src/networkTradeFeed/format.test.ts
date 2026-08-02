import { describe, expect, it } from 'vitest';
import { buildNetworkTradeCaptionHtml, formatSolSigned, formatUsdSigned } from './format.js';
import type { NetworkTradeCandidate } from './data.js';

const NOW = new Date('2026-08-02T12:00:00Z');

function candidate(overrides: Partial<NetworkTradeCandidate> = {}): NetworkTradeCandidate {
  return {
    entryId: 'entry1',
    mint: 'MintAAAA1111111111111111111111111111111111',
    tokenName: 'Gigachad',
    tokenSymbol: 'GIGA',
    dex: 'PUMPFUN',
    aiScore: 72,
    walletAddress: 'WalletAAAA1111111111111111111111111111111',
    walletConfidenceScore: 65,
    entryAt: new Date('2026-08-01T00:00:00Z'),
    exitAt: new Date('2026-08-01T02:30:00Z'),
    entrySignature: 'buysig',
    exitSignature: 'sellsig',
    entryPriceUsd: 0.001,
    exitPriceUsd: 0.0018,
    entryAmountSol: 1,
    exitAmountSol: 1.8,
    realizedRoiPercent: 80,
    realizedPnlSol: 0.8,
    realizedPnlUsd: 150,
    ...overrides,
  };
}

describe('formatSolSigned', () => {
  it('signs a positive amount', () => {
    expect(formatSolSigned(1.25)).toBe('+1.250 SOL');
  });

  it('signs a negative amount', () => {
    expect(formatSolSigned(-0.4)).toBe('-0.400 SOL');
  });
});

describe('formatUsdSigned', () => {
  it('signs a positive amount with thousands separators', () => {
    expect(formatUsdSigned(1250)).toBe('+$1,250.00');
  });

  it('signs a negative amount', () => {
    expect(formatUsdSigned(-400)).toBe('-$400.00');
  });
});

describe('buildNetworkTradeCaptionHtml', () => {
  it('uses a profit header and includes every required field for a winning trade', () => {
    const html = buildNetworkTradeCaptionHtml(
      candidate(),
      { liquidityUsd: 42_000, marketCapUsd: 1_200_000 },
      NOW,
    );

    expect(html).toContain('PROFIT');
    expect(html).toContain('NETWORK TRADE');
    expect(html).toContain('GIGA');
    expect(html).toContain('+80.0%');
    expect(html).toContain('+$150.00');
    expect(html).toContain('+0.800 SOL');
    expect(html).toContain('2h 30m');
    expect(html).toContain('72/100');
    expect(html).toContain('PUMPFUN');
  });

  it('uses a loss header for a losing trade', () => {
    const html = buildNetworkTradeCaptionHtml(
      candidate({ realizedRoiPercent: -40, realizedPnlUsd: -60, realizedPnlSol: -0.3 }),
      { liquidityUsd: 10_000, marketCapUsd: 200_000 },
      NOW,
    );

    expect(html).toContain('LOSS');
    expect(html).not.toContain('PROFIT');
    expect(html).toContain('-40.0%');
    expect(html).toContain('-$60.00');
  });

  it('shows N/A rather than a fabricated number for missing aiScore/enrichment', () => {
    const html = buildNetworkTradeCaptionHtml(
      candidate({ aiScore: undefined }),
      { liquidityUsd: undefined, marketCapUsd: undefined },
      NOW,
    );

    const naCount = (html.match(/N\/A/g) ?? []).length;
    expect(naCount).toBeGreaterThanOrEqual(3); // liquidity, market cap, ai score
  });

  it('shows the wallet address shortened, never the full address', () => {
    const html = buildNetworkTradeCaptionHtml(
      candidate(),
      { liquidityUsd: 1000, marketCapUsd: 1000 },
      NOW,
    );

    expect(html).not.toContain(candidate().walletAddress);
    expect(html).toContain('…');
  });

  it("never exceeds Telegram's photo caption limit", () => {
    const html = buildNetworkTradeCaptionHtml(
      candidate({ tokenName: 'A'.repeat(2000) }),
      { liquidityUsd: 1000, marketCapUsd: 1000 },
      NOW,
    );
    expect(html.length).toBeLessThanOrEqual(1024);
  });
});
