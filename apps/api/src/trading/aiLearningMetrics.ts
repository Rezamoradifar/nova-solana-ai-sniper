/**
 * AI learning metrics (Phase 7d, 2026-07-29) — pure functions over real
 * closed-position records (caller supplies the array, e.g. mapped from
 * Prisma Position rows) that answer two questions this codebase had no
 * standing way to answer:
 *
 *   1. Entry decision analysis — did Position.riskScoreAtEntry (the
 *      min(ruleScore, aiScore) that actually gated+sized each trade, see
 *      autoTrader.ts) actually predict which trades made money?
 *   2. Exit decision analysis — which ExitReason (take_profit/stop_loss/
 *      trailing_stop/emergency/manual_emergency) is actually driving
 *      outcomes, and how does each perform?
 *
 * Deliberately takes plain records, not a PrismaClient — same convention as
 * backtest.ts/backtestMetrics.ts, so this stays independently unit-testable
 * and the caller (a route, script, or future dashboard) controls exactly
 * which positions are in scope (date range, real vs paper, per-wallet, etc).
 */

export interface EntryDecisionRecord {
  scoreAtEntry: number | null;
  pnlPercent: number;
}

export interface ScoreBucket {
  /** Inclusive lower bound of the bucket, e.g. 80 for the "80-100" bucket. */
  rangeStart: number;
  rangeEnd: number;
  count: number;
  winRate: number;
  avgPnlPercent: number;
}

export interface EntryDecisionAnalysis {
  /** Records with a null scoreAtEntry are excluded from every figure below
   * (pre-AI-scoring positions, or positions opened before this field
   * existed) — counted separately so callers know how much data was
   * skipped. */
  excludedNullScoreCount: number;
  buckets: ScoreBucket[];
  /** Pearson correlation coefficient between scoreAtEntry and pnlPercent
   * across every scored record — 0 when fewer than 2 scored records exist
   * (nothing to correlate). Ranges -1..1; near 0 means the score has no
   * observed relationship with outcome in this data. */
  correlation: number;
  recommendation: string;
}

/**
 * Buckets scored records into fixed-width score ranges (default width 20,
 * matching a 0-100 score into five buckets) and computes per-bucket win rate
 * / average PnL, plus the overall Pearson correlation between score and
 * outcome — the calibration check: a well-calibrated score should show
 * monotonically increasing win rate/avgPnlPercent as the bucket range rises.
 */
export function analyzeEntryDecisions(
  records: EntryDecisionRecord[],
  bucketWidth = 20,
): EntryDecisionAnalysis {
  const scored = records.filter(
    (r): r is EntryDecisionRecord & { scoreAtEntry: number } => r.scoreAtEntry != null,
  );
  const excludedNullScoreCount = records.length - scored.length;

  const bucketMap = new Map<number, EntryDecisionRecord[]>();
  for (const record of scored) {
    const rangeStart = Math.floor(record.scoreAtEntry / bucketWidth) * bucketWidth;
    const existing = bucketMap.get(rangeStart);
    if (existing) existing.push(record);
    else bucketMap.set(rangeStart, [record]);
  }

  const buckets: ScoreBucket[] = [...bucketMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rangeStart, bucketRecords]) => {
      const wins = bucketRecords.filter((r) => r.pnlPercent > 0).length;
      return {
        rangeStart,
        rangeEnd: rangeStart + bucketWidth,
        count: bucketRecords.length,
        winRate: wins / bucketRecords.length,
        avgPnlPercent:
          bucketRecords.reduce((sum, r) => sum + r.pnlPercent, 0) / bucketRecords.length,
      };
    });

  const correlation = pearsonCorrelation(
    scored.map((r) => r.scoreAtEntry),
    scored.map((r) => r.pnlPercent),
  );

  let recommendation: string;
  if (scored.length < 5) {
    recommendation = 'Not enough scored trades yet to draw a conclusion (need at least 5).';
  } else if (correlation > 0.2) {
    recommendation =
      'Entry score positively correlates with outcome — higher-scored trades are winning more. ' +
      'Consider raising the entry threshold to concentrate capital in the top-scoring band.';
  } else if (correlation < -0.2) {
    recommendation =
      'Entry score NEGATIVELY correlates with outcome — higher-scored trades are doing worse, not ' +
      'better. This suggests the scoring model itself needs investigation, not just the threshold.';
  } else {
    recommendation =
      'Entry score shows no meaningful correlation with outcome in this data — the score is not ' +
      'currently predictive.';
  }

  return { excludedNullScoreCount, buckets, correlation, recommendation };
}

export interface ExitDecisionRecord {
  exitReason: string | null;
  pnlPercent: number;
}

export interface ExitReasonBreakdown {
  exitReason: string;
  count: number;
  winRate: number;
  avgPnlPercent: number;
  totalPnlPercent: number;
}

export interface ExitDecisionAnalysis {
  excludedNullReasonCount: number;
  byReason: ExitReasonBreakdown[];
}

/** Groups closed positions by their actual ExitReason and computes per-reason
 * performance — e.g. "is stop_loss firing on trades that would have
 * recovered" or "is trailing_stop capturing more than take_profit." Sorted
 * by count descending (the most common exit path first). */
export function analyzeExitDecisions(records: ExitDecisionRecord[]): ExitDecisionAnalysis {
  const withReason = records.filter(
    (r): r is ExitDecisionRecord & { exitReason: string } => r.exitReason != null,
  );
  const excludedNullReasonCount = records.length - withReason.length;

  const byReasonMap = new Map<string, ExitDecisionRecord[]>();
  for (const record of withReason) {
    const existing = byReasonMap.get(record.exitReason);
    if (existing) existing.push(record);
    else byReasonMap.set(record.exitReason, [record]);
  }

  const byReason: ExitReasonBreakdown[] = [...byReasonMap.entries()]
    .map(([exitReason, reasonRecords]) => {
      const wins = reasonRecords.filter((r) => r.pnlPercent > 0).length;
      const totalPnlPercent = reasonRecords.reduce((sum, r) => sum + r.pnlPercent, 0);
      return {
        exitReason,
        count: reasonRecords.length,
        winRate: wins / reasonRecords.length,
        avgPnlPercent: totalPnlPercent / reasonRecords.length,
        totalPnlPercent,
      };
    })
    .sort((a, b) => b.count - a.count);

  return { excludedNullReasonCount, byReason };
}

export interface AiLearningReport {
  entry: EntryDecisionAnalysis;
  exit: ExitDecisionAnalysis;
  recommendations: string[];
}

/** The single call site most callers want — combines entry + exit analysis
 * into one report with a flat list of every recommendation surfaced. */
export function buildAiLearningReport(
  entryRecords: EntryDecisionRecord[],
  exitRecords: ExitDecisionRecord[],
): AiLearningReport {
  const entry = analyzeEntryDecisions(entryRecords);
  const exit = analyzeExitDecisions(exitRecords);

  const recommendations = [entry.recommendation];
  const worstReason = [...exit.byReason].sort((a, b) => a.avgPnlPercent - b.avgPnlPercent)[0];
  if (worstReason && worstReason.count >= 5 && worstReason.avgPnlPercent < 0) {
    recommendations.push(
      `"${worstReason.exitReason}" exits average ${worstReason.avgPnlPercent.toFixed(1)}% PnL ` +
        `across ${worstReason.count} trades — the worst-performing exit path in this data.`,
    );
  }

  return { entry, exit, recommendations };
}

/** Standard Pearson correlation coefficient. Returns 0 for fewer than 2
 * points or when either series has zero variance (correlation undefined,
 * reported as "no observed relationship" rather than NaN). */
function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;

  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;

  let numerator = 0;
  let sumSqX = 0;
  let sumSqY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    numerator += dx * dy;
    sumSqX += dx * dx;
    sumSqY += dy * dy;
  }

  const denominator = Math.sqrt(sumSqX * sumSqY);
  if (denominator === 0) return 0;
  return numerator / denominator;
}
