import { describe, expect, it } from 'vitest';
import {
  calculateWinRate,
  calculateRoi,
  calculateProfitFactor,
  calculateMaxDrawdown,
  calculateSharpeRatio,
  summarizePerformance,
  type TradeOutcome,
} from './backtestMetrics.js';

const win = (pnlPercent: number, pnlAmount: number): TradeOutcome => ({ pnlPercent, pnlAmount });

describe('calculateWinRate', () => {
  it('is 0 for an empty list', () => {
    expect(calculateWinRate([])).toBe(0);
  });

  it('counts only strictly-positive pnlAmount as a win', () => {
    const trades = [win(10, 1), win(-5, -1), win(0, 0)];
    expect(calculateWinRate(trades)).toBeCloseTo(1 / 3);
  });
});

describe('calculateRoi', () => {
  it('is 0 when totalInvested is 0 or negative', () => {
    expect(calculateRoi([win(10, 1)], 0)).toBe(0);
    expect(calculateRoi([win(10, 1)], -5)).toBe(0);
  });

  it('is total pnl as a percent of total invested', () => {
    const trades = [win(50, 5), win(-20, -2)];
    expect(calculateRoi(trades, 10)).toBeCloseTo(30); // (5-2)/10 * 100
  });
});

describe('calculateProfitFactor', () => {
  it('is grossProfit / grossLoss', () => {
    const trades = [win(10, 4), win(20, 6), win(-5, -2), win(-5, -3)];
    expect(calculateProfitFactor(trades)).toBeCloseTo(2); // 10 / 5
  });

  it('is Infinity when there are wins and no losses', () => {
    expect(calculateProfitFactor([win(10, 5)])).toBe(Infinity);
  });

  it('is 0 when there are no wins and no losses', () => {
    expect(calculateProfitFactor([win(0, 0)])).toBe(0);
  });
});

describe('calculateMaxDrawdown', () => {
  it('is 0 for a monotonically increasing equity curve', () => {
    const trades = [win(10, 1), win(10, 1), win(10, 1)];
    const result = calculateMaxDrawdown(trades);
    expect(result.maxDrawdownAmount).toBe(0);
    expect(result.maxDrawdownPercent).toBe(0);
  });

  it('finds the largest peak-to-trough decline, not just the last drop', () => {
    // cumulative: 10 -> 15 (peak) -> 5 (dd=10) -> 8 -> 4 (dd=11, the max) -> 20
    const trades = [win(0, 10), win(0, 5), win(0, -10), win(0, 3), win(0, -4), win(0, 16)];
    const result = calculateMaxDrawdown(trades);
    expect(result.maxDrawdownAmount).toBeCloseTo(11);
    expect(result.maxDrawdownPercent).toBeCloseTo((11 / 15) * 100);
  });
});

describe('calculateSharpeRatio', () => {
  it('is 0 with fewer than 2 trades', () => {
    expect(calculateSharpeRatio([])).toBe(0);
    expect(calculateSharpeRatio([win(10, 1)])).toBe(0);
  });

  it('is 0 when every trade has identical pnlPercent (zero variance)', () => {
    expect(calculateSharpeRatio([win(10, 1), win(10, 1), win(10, 1)])).toBe(0);
  });

  it('is positive when returns are consistently above the risk-free rate', () => {
    const trades = [win(10, 1), win(15, 1), win(5, 1), win(20, 1)];
    expect(calculateSharpeRatio(trades)).toBeGreaterThan(0);
  });
});

describe('summarizePerformance', () => {
  it('combines every metric into one summary', () => {
    const trades = [win(50, 5), win(-20, -2), win(30, 3)];
    const summary = summarizePerformance(trades, 10);

    expect(summary.totalTrades).toBe(3);
    expect(summary.wins).toBe(2);
    expect(summary.losses).toBe(1);
    expect(summary.winRate).toBeCloseTo(2 / 3);
    expect(summary.totalPnlAmount).toBeCloseTo(6);
    expect(summary.avgPnlPercent).toBeCloseTo(20);
    expect(summary.roi).toBeCloseTo(60);
    expect(summary.profitFactor).toBeCloseTo(4); // 8 / 2
    expect(summary.maxDrawdownAmount).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(summary.sharpeRatio)).toBe(true);
  });

  it('never throws on an empty trade list', () => {
    const summary = summarizePerformance([]);
    expect(summary.totalTrades).toBe(0);
    expect(summary.winRate).toBe(0);
    expect(summary.roi).toBe(0);
  });
});
