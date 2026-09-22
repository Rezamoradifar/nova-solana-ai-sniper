import { describe, expect, it } from 'vitest';
import {
  formatNewOpportunityMessage,
  formatMarketActivityMessage,
  formatTrendingTokenMessage,
  formatWhaleAlertMessage,
  formatSecurityAlertMessage,
  formatWeeklySummaryMessage,
  computeDailySummaryStats,
} from './format.js';
import type { DexScreenerEnrichment } from '../marketData.js';

function enrichment(overrides: Partial<DexScreenerEnrichment> = {}): DexScreenerEnrichment {
  return {
    logoUrl: undefined,
    liquidityUsd: 12_000,
    marketCapUsd: 80_000,
    volume24hUsd: 45_000,
    priceChangeH1Percent: 22.5,
    chain: 'Solana',
    dexScreenerUrl: 'https://dexscreener.com/solana/MintAbc123',
    ...overrides,
  };
}

describe('formatNewOpportunityMessage', () => {
  it('renders only real fields, omitting unresolved ones, plus brand footer and DexScreener link', () => {
    const text = formatNewOpportunityMessage({
      id: 't1',
      mint: 'MintAbc123',
      name: 'Example Token',
      symbol: 'EXT',
      dex: 'RAYDIUM',
      liquidityUsd: undefined,
      marketCapUsd: 12_345,
      aiScore: undefined,
      firstSeenAt: new Date('2026-07-27T08:43:00Z'),
    });
    expect(text).toContain('NEW OPPORTUNITY');
    expect(text).toContain('EXT');
    expect(text).toContain('Market Cap');
    expect(text).not.toContain('Liquidity:');
    expect(text).not.toContain('AI Score:');
    expect(text).toContain('View on DexScreener');
    expect(text).toContain('GSP Bank Sniper');
  });

  it('includes DexScreener enrichment lines when available', () => {
    const text = formatNewOpportunityMessage(
      {
        id: 't1',
        mint: 'MintAbc123',
        name: 'Example',
        symbol: 'EXT',
        dex: 'RAYDIUM',
        liquidityUsd: undefined,
        marketCapUsd: undefined,
        aiScore: 90,
        firstSeenAt: new Date('2026-07-27T08:43:00Z'),
      },
      enrichment(),
    );
    expect(text).toContain('Chain: Solana');
    expect(text).toContain('24h Volume');
    expect(text).toContain('90/100');
  });
});

describe('formatMarketActivityMessage', () => {
  it('reports the real token and enrichment, distinct from a bot-trade post', () => {
    const text = formatMarketActivityMessage(
      {
        id: 't1:2026-07-28',
        mint: 'MintAbc123',
        name: 'Example',
        symbol: 'EXT',
        dex: 'RAYDIUM',
        detectedAt: new Date('2026-07-28T08:43:00Z'),
      },
      enrichment(),
    );
    expect(text).toContain('MARKET ACTIVITY');
    expect(text).toContain('Liquidity');
    expect(text).toContain('View on DexScreener');
  });

  it('omits enrichment lines entirely when the lookup failed', () => {
    const text = formatMarketActivityMessage(
      {
        id: 't1:2026-07-28',
        mint: 'MintAbc123',
        name: 'Example',
        symbol: 'EXT',
        dex: 'RAYDIUM',
        detectedAt: new Date('2026-07-28T08:43:00Z'),
      },
      undefined,
    );
    expect(text).not.toContain('Liquidity');
    expect(text).not.toContain('Chain:');
  });
});

describe('formatTrendingTokenMessage', () => {
  it('shows the real 1h price change that made it qualify as trending', () => {
    const text = formatTrendingTokenMessage(
      {
        id: 't1:2026-07-28',
        mint: 'MintAbc123',
        name: 'Example',
        symbol: 'EXT',
        dex: 'RAYDIUM',
        detectedAt: new Date('2026-07-28T08:43:00Z'),
      },
      enrichment({ priceChangeH1Percent: 41.2 }),
    );
    expect(text).toContain('TRENDING TOKEN');
    expect(text).toContain('+41.2%');
  });
});

describe('formatWhaleAlertMessage', () => {
  it('renders real confidence/win-rate fields, not an invented SOL amount', () => {
    const text = formatWhaleAlertMessage({
      id: 'e1',
      walletAddress: 'Wa11etAddressLongEnoughToShorten',
      mint: 'MintAbc123',
      tokenName: 'Example',
      tokenSymbol: 'EXT',
      confidenceScore: 96,
      winRate: 71,
      entryMarketCapUsd: 50_000,
      entryAt: new Date('2026-07-27T08:43:00Z'),
    });
    expect(text).toContain('WHALE ALERT');
    expect(text).toContain('96%');
    expect(text).toContain('71%');
    expect(text).not.toMatch(/\d+\s*SOL/);
  });
});

describe('formatSecurityAlertMessage', () => {
  it('renders the expected headline and real safety score', () => {
    const text = formatSecurityAlertMessage({
      id: 's1',
      mint: 'MintAbc123',
      name: 'Example',
      symbol: 'EXT',
      safetyScore: 88,
      detectedAt: new Date('2026-07-27T08:43:00Z'),
    });
    expect(text).toContain('SECURITY ALERT');
    expect(text).toContain('88/100');
  });
});

describe('formatWeeklySummaryMessage', () => {
  it('reports zero trades honestly rather than omitting the message', () => {
    const stats = computeDailySummaryStats('2026-07-20 to 2026-07-26', []);
    expect(formatWeeklySummaryMessage(stats)).toContain('No closed trades this week');
  });

  it('reports real win/loss totals for a populated week', () => {
    const trades = [
      {
        positionId: 'p1',
        mint: 'MintA',
        tokenName: 'A',
        tokenSymbol: 'AAA',
        dex: 'RAYDIUM',
        buyAt: new Date('2026-07-21T00:00:00Z'),
        sellAt: new Date('2026-07-21T01:00:00Z'),
        entryPriceUsd: 1,
        exitPriceUsd: 1.3,
        roiPercent: 30,
        pnlUsd: 30,
        buySignature: 'sig1',
        sellSignature: 'sig2',
        aiScore: 90,
      },
    ];
    const stats = computeDailySummaryStats('2026-07-20 to 2026-07-26', trades);
    const text = formatWeeklySummaryMessage(stats);
    expect(text).toContain('WEEKLY SUMMARY');
    expect(text).toContain('1 win, 0 loss');
    expect(text).toContain('Best: *AAA* +30.0%');
    expect(text).toContain('GSP Bank Sniper');
  });
});
