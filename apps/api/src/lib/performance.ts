/**
 * Trading performance from real SOL flows: each closed position's invested SOL
 * vs. the SOL its SELL trades returned (so slippage, price impact and fees are
 * all counted), grouped the ways that help tune the strategy.
 */

export interface ClosedPositionResult {
  investedSol: number;
  returnedSol: number;
  exitReason: string | null;
  dex: string;
  holdMs: number;
}

export interface PerformanceBucket {
  key: string;
  trades: number;
  wins: number;
  winRatePercent: number;
  netSol: number;
  roiPercent: number;
}

export interface PerformanceSummary extends Omit<PerformanceBucket, 'key'> {
  losses: number;
  investedSol: number;
  returnedSol: number;
  avgWinPercent: number;
  avgLossPercent: number;
}

export interface PerformanceReport {
  summary: PerformanceSummary;
  byExitReason: PerformanceBucket[];
  byDex: PerformanceBucket[];
  byHoldTime: PerformanceBucket[];
}

/** Paper positions closed within this window as "stop_loss" were the zero-balance
 * reconciliation bug (fixed 2026-09-26), not real outcomes — excluded. */
export const INVALID_PAPER_HOLD_MS = 15_000;

function holdBucket(ms: number): string {
  const min = ms / 60_000;
  if (min < 5) return '< 5 min';
  if (min < 15) return '5–15 min';
  if (min < 60) return '15–60 min';
  return '> 1 h';
}

function bucket(key: string, rows: ClosedPositionResult[]): PerformanceBucket {
  const invested = rows.reduce((s, r) => s + r.investedSol, 0);
  const netSol = rows.reduce((s, r) => s + (r.returnedSol - r.investedSol), 0);
  const wins = rows.filter((r) => r.returnedSol > r.investedSol).length;
  return {
    key,
    trades: rows.length,
    wins,
    winRatePercent: rows.length ? (wins / rows.length) * 100 : 0,
    netSol,
    roiPercent: invested > 0 ? (netSol / invested) * 100 : 0,
  };
}

function groupBy(
  rows: ClosedPositionResult[],
  keyOf: (r: ClosedPositionResult) => string,
): PerformanceBucket[] {
  const groups = new Map<string, ClosedPositionResult[]>();
  for (const r of rows) {
    const k = keyOf(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()].map(([k, g]) => bucket(k, g)).sort((a, b) => b.trades - a.trades);
}

export function computePerformance(rows: ClosedPositionResult[]): PerformanceReport {
  const base = bucket('all', rows);
  const pct = (r: ClosedPositionResult) =>
    r.investedSol > 0 ? ((r.returnedSol - r.investedSol) / r.investedSol) * 100 : 0;
  const winners = rows.filter((r) => r.returnedSol > r.investedSol);
  const losers = rows.filter((r) => r.returnedSol <= r.investedSol);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    summary: {
      trades: base.trades,
      wins: base.wins,
      losses: rows.length - base.wins,
      winRatePercent: base.winRatePercent,
      netSol: base.netSol,
      roiPercent: base.roiPercent,
      investedSol: rows.reduce((s, r) => s + r.investedSol, 0),
      returnedSol: rows.reduce((s, r) => s + r.returnedSol, 0),
      avgWinPercent: avg(winners.map(pct)),
      avgLossPercent: avg(losers.map(pct)),
    },
    byExitReason: groupBy(rows, (r) => r.exitReason ?? 'manual'),
    byDex: groupBy(rows, (r) => r.dex),
    byHoldTime: groupBy(rows, (r) => holdBucket(r.holdMs)),
  };
}
