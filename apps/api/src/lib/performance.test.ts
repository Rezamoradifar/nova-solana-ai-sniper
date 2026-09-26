import { describe, expect, it } from 'vitest';
import { computePerformance } from './performance.js';

const row = (
  invested: number,
  returned: number,
  exitReason: string,
  dex = 'PUMPSWAP',
  holdMin = 10,
) => ({
  investedSol: invested,
  returnedSol: returned,
  exitReason,
  dex,
  holdMs: holdMin * 60_000,
});

describe('computePerformance', () => {
  it('summarizes real SOL results, win rate and average win/loss', () => {
    const r = computePerformance([
      row(0.1, 0.1257, 'trailing_stop'),
      row(0.1, 0.0803, 'stop_loss'),
      row(0.1, 0.0871, 'stop_loss'),
    ]);
    expect(r.summary.trades).toBe(3);
    expect(r.summary.wins).toBe(1);
    expect(r.summary.losses).toBe(2);
    expect(r.summary.netSol).toBeCloseTo(-0.0069);
    expect(r.summary.roiPercent).toBeCloseTo(-2.3);
    expect(r.summary.avgWinPercent).toBeCloseTo(25.7);
    expect(r.summary.avgLossPercent).toBeCloseTo(-16.3);
  });

  it('groups by exit reason, DEX and hold time', () => {
    const r = computePerformance([
      row(0.1, 0.12, 'trailing_stop', 'PUMPSWAP', 3),
      row(0.1, 0.08, 'stop_loss', 'RAYDIUM', 30),
      row(0.1, 0.09, 'stop_loss', 'PUMPSWAP', 30),
    ]);
    expect(r.byExitReason.find((b) => b.key === 'stop_loss')?.trades).toBe(2);
    expect(r.byDex.find((b) => b.key === 'PUMPSWAP')?.wins).toBe(1);
    expect(r.byHoldTime.map((b) => b.key).sort()).toEqual(['15–60 min', '< 5 min']);
  });

  it('handles no trades', () => {
    const r = computePerformance([]);
    expect(r.summary.trades).toBe(0);
    expect(r.summary.roiPercent).toBe(0);
  });
});
