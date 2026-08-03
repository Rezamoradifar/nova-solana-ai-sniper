import { describe, expect, it } from 'vitest';
import {
  analyzeEntryDecisions,
  analyzeExitDecisions,
  buildAiLearningReport,
} from './aiLearningMetrics.js';

describe('analyzeEntryDecisions', () => {
  it('excludes null-score records and counts them separately', () => {
    const result = analyzeEntryDecisions([
      { scoreAtEntry: null, pnlPercent: 10 },
      { scoreAtEntry: 90, pnlPercent: 20 },
    ]);
    expect(result.excludedNullScoreCount).toBe(1);
    expect(result.buckets.reduce((s, b) => s + b.count, 0)).toBe(1);
  });

  it('buckets scores into fixed-width ranges and computes per-bucket win rate', () => {
    const records = [
      { scoreAtEntry: 85, pnlPercent: 30 },
      { scoreAtEntry: 90, pnlPercent: -10 },
      { scoreAtEntry: 25, pnlPercent: -20 },
      { scoreAtEntry: 35, pnlPercent: -15 },
    ];
    const result = analyzeEntryDecisions(records);
    const highBucket = result.buckets.find((b) => b.rangeStart === 80);
    const lowBucket = result.buckets.find((b) => b.rangeStart === 20);

    expect(highBucket?.count).toBe(2);
    expect(highBucket?.winRate).toBeCloseTo(0.5);
    expect(lowBucket?.count).toBe(2);
    expect(lowBucket?.winRate).toBe(0);
  });

  it('reports a positive correlation when higher scores consistently win more', () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      scoreAtEntry: i * 10,
      pnlPercent: i * 10 - 40, // negative for low scores, positive for high
    }));
    const result = analyzeEntryDecisions(records);
    expect(result.correlation).toBeGreaterThan(0.5);
    expect(result.recommendation).toContain('positively correlate');
  });

  it('flags insufficient data with fewer than 5 scored trades', () => {
    const result = analyzeEntryDecisions([{ scoreAtEntry: 80, pnlPercent: 10 }]);
    expect(result.recommendation).toContain('Not enough scored trades');
  });
});

describe('analyzeExitDecisions', () => {
  it('groups by exit reason and sorts by count descending', () => {
    const records = [
      { exitReason: 'take_profit', pnlPercent: 20 },
      { exitReason: 'take_profit', pnlPercent: 30 },
      { exitReason: 'stop_loss', pnlPercent: -15 },
      { exitReason: null, pnlPercent: 5 },
    ];
    const result = analyzeExitDecisions(records);
    expect(result.excludedNullReasonCount).toBe(1);
    expect(result.byReason[0]!.exitReason).toBe('take_profit');
    expect(result.byReason[0]!.count).toBe(2);
    expect(result.byReason[0]!.avgPnlPercent).toBeCloseTo(25);
    expect(result.byReason[1]!.exitReason).toBe('stop_loss');
    expect(result.byReason[1]!.winRate).toBe(0);
  });
});

describe('buildAiLearningReport', () => {
  it('combines entry and exit analysis and surfaces a worst-exit-reason recommendation', () => {
    const entryRecords = Array.from({ length: 6 }, () => ({
      scoreAtEntry: 50,
      pnlPercent: 0,
    }));
    const exitRecords = [
      { exitReason: 'stop_loss', pnlPercent: -25 },
      { exitReason: 'stop_loss', pnlPercent: -20 },
      { exitReason: 'stop_loss', pnlPercent: -22 },
      { exitReason: 'stop_loss', pnlPercent: -18 },
      { exitReason: 'stop_loss', pnlPercent: -30 },
      { exitReason: 'take_profit', pnlPercent: 40 },
    ];
    const report = buildAiLearningReport(entryRecords, exitRecords);
    expect(report.entry.buckets.length).toBeGreaterThan(0);
    expect(report.exit.byReason.length).toBe(2);
    expect(report.recommendations.some((r) => r.includes('stop_loss'))).toBe(true);
  });
});
