import { describe, expect, it } from 'vitest';
import {
  formatTradeShowcaseMessage,
  computeDailySummaryStats,
  formatDailySummaryMessage,
  solscanTxUrl,
  solscanTokenUrl,
  dexscreenerChartUrl,
} from './format.js';
import type { ShowcaseTrade } from './data.js';
import type { DexScreenerEnrichment } from '../marketData.js';

function trade(overrides: Partial<ShowcaseTrade> = {}): ShowcaseTrade {
  return {
    positionId: 'pos1',
    mint: 'MintAbc123',
    tokenName: 'Example Token',
    tokenSymbol: 'EXT',
    dex: 'RAYDIUM',
    buyAt: new Date('2026-07-27T10:00:00Z'),
    sellAt: new Date('2026-07-27T10:30:00Z'),
    entryPriceUsd: 0.001,
    exitPriceUsd: 0.0015,
    roiPercent: 50,
    pnlUsd: 25,
    buySignature: 'buySig123',
    sellSignature: 'sellSig456',
    aiScore: 92,
    ...overrides,
  };
}

function enrichment(overrides: Partial<DexScreenerEnrichment> = {}): DexScreenerEnrichment {
  return {
    logoUrl: undefined,
    liquidityUsd: 12_000,
    marketCapUsd: 80_000,
    volume24hUsd: 45_000,
    priceChangeH1Percent: 5,
    chain: 'Solana',
    dexScreenerUrl: 'https://dexscreener.com/solana/MintAbc123',
    ...overrides,
  };
}

describe('link builders', () => {
  it('build real, direct Solscan/DexScreener URLs — no third-party redirect or shortener', () => {
    expect(solscanTxUrl('abc')).toBe('https://solscan.io/tx/abc');
    expect(solscanTokenUrl('MintX')).toBe('https://solscan.io/token/MintX');
    expect(dexscreenerChartUrl('MintX')).toBe('https://dexscreener.com/solana/MintX');
  });
});

describe('formatTradeShowcaseMessage', () => {
  it('includes every required field: token name, address, buy time, sell time, ROI, PnL, hold time, AI score, tx links, chart link, brand footer', () => {
    const text = formatTradeShowcaseMessage(trade());
    expect(text).toContain('REAL BOT TRADE');
    expect(text).toContain('EXT');
    expect(text).toContain('Example Token');
    expect(text).toContain('MintAbc123');
    expect(text).toContain('2026-07-27 10:00');
    expect(text).toContain('2026-07-27 10:30');
    expect(text).toContain('held');
    expect(text).toContain('+50.0%');
    expect(text).toContain('$25.00');
    expect(text).toContain('92/100');
    expect(text).toContain('https://solscan.io/tx/buySig123');
    expect(text).toContain('https://solscan.io/tx/sellSig456');
    expect(text).toContain('https://dexscreener.com/solana/MintAbc123');
    expect(text).toContain('Nova Solana AI Sniper');
  });

  it('omits the AI Score line when the position has no recorded risk score', () => {
    const text = formatTradeShowcaseMessage(trade({ aiScore: undefined }));
    expect(text).not.toContain('AI Score:');
  });

  it('includes DexScreener enrichment lines when available', () => {
    const text = formatTradeShowcaseMessage(trade(), enrichment());
    expect(text).toContain('Chain: Solana');
    expect(text).toContain('Liquidity');
    expect(text).toContain('24h Volume');
  });

  it('renders a real losing trade with a negative ROI sign and a loss emoji, unmodified', () => {
    const text = formatTradeShowcaseMessage(trade({ roiPercent: -35.2, pnlUsd: -12.5 }));
    expect(text).toContain('-35.2%');
    expect(text).toContain('-$12.50');
    expect(text).toContain('🔴');
  });

  it('marks a real winning trade with a win emoji', () => {
    const text = formatTradeShowcaseMessage(trade({ roiPercent: 200, pnlUsd: 80 }));
    expect(text).toContain('🟢');
  });

  it('escapes Markdown special characters in a token name/symbol so a malicious/odd token name cannot break the post', () => {
    const text = formatTradeShowcaseMessage(
      trade({ tokenName: '[Fake_Link](http://evil.example)', tokenSymbol: 'A*B' }),
    );
    expect(text).toContain('A\\*B');
    expect(text).toContain('\\[Fake\\_Link\\]');
  });

  it('omits a tx link field entirely when that signature could not be resolved, rather than fabricating one', () => {
    const text = formatTradeShowcaseMessage(trade({ buySignature: undefined }));
    expect(text).not.toContain('Buy tx on Solscan');
    expect(text).toContain('Sell tx on Solscan');
  });

  it('falls back to a shortened mint when neither name nor symbol is known', () => {
    const text = formatTradeShowcaseMessage(
      trade({ tokenName: undefined, tokenSymbol: undefined, mint: 'AbcdefghijklmnopqrstuvWXYZ' }),
    );
    expect(text).toContain('Abcdef…WXYZ');
  });
});

describe('computeDailySummaryStats', () => {
  it('reports true daily totals from a mix of real wins and losses — no filtering by magnitude or count', () => {
    const trades = [
      trade({ positionId: 'a', roiPercent: 400, pnlUsd: 100 }),
      trade({ positionId: 'b', roiPercent: -60, pnlUsd: -30 }),
      trade({ positionId: 'c', roiPercent: 5, pnlUsd: 2 }),
    ];
    const stats = computeDailySummaryStats('2026-07-27', trades);
    expect(stats.tradeCount).toBe(3);
    expect(stats.winCount).toBe(2);
    expect(stats.lossCount).toBe(1);
    expect(stats.totalPnlUsd).toBe(72);
    expect(stats.bestTrade?.positionId).toBe('a');
    expect(stats.worstTrade?.positionId).toBe('b');
  });

  it('reports zero trades honestly rather than omitting the day or fabricating a result', () => {
    const stats = computeDailySummaryStats('2026-07-27', []);
    expect(stats.tradeCount).toBe(0);
    expect(stats.bestTrade).toBeUndefined();
  });

  it('reports a net-loss day as a net loss — no survivorship bias', () => {
    const trades = [
      trade({ positionId: 'a', roiPercent: -15, pnlUsd: -10 }),
      trade({ positionId: 'b', roiPercent: -25, pnlUsd: -20 }),
    ];
    const stats = computeDailySummaryStats('2026-07-27', trades);
    expect(stats.winCount).toBe(0);
    expect(stats.lossCount).toBe(2);
    expect(stats.totalPnlUsd).toBe(-30);
  });
});

describe('formatDailySummaryMessage', () => {
  it("renders a real net-loss day's negative total rather than hiding it", () => {
    const stats = computeDailySummaryStats('2026-07-27', [
      trade({ positionId: 'a', roiPercent: -15, pnlUsd: -10 }),
    ]);
    const text = formatDailySummaryMessage(stats);
    expect(text).toContain('DAILY PERFORMANCE');
    expect(text).toContain('-$10.00');
    expect(text).toContain('0.0%'); // win rate
    expect(text).toContain('Nova Solana AI Sniper');
  });

  it('reports "no closed trades today" honestly instead of skipping the post or inventing content', () => {
    const stats = computeDailySummaryStats('2026-07-27', []);
    const text = formatDailySummaryMessage(stats);
    expect(text).toContain('No closed trades today');
  });

  it('omits the "Worst" line when every trade that day was profitable', () => {
    const stats = computeDailySummaryStats('2026-07-27', [
      trade({ positionId: 'a', roiPercent: 20, pnlUsd: 10 }),
    ]);
    const text = formatDailySummaryMessage(stats);
    expect(text).not.toContain('Worst:');
  });
});
