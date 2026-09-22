import { describe, expect, it } from 'vitest';
import { computeDailySummaryStats, formatDailySummaryMessage } from './format.js';
import type { ShowcaseTrade } from './data.js';

// Per-trade formatting (formatTradeShowcaseMessage, the URL builders) moved
// to apps/telegram-bot/src/tradeNotification.ts (2026-07-28) — see
// tradeNotification.test.ts for that coverage. Only the daily aggregate
// summary is tested here now.

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
    expect(text).toContain('GSP Bank Sniper');
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
