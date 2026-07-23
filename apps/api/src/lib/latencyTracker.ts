/**
 * Production Latency Optimization, Stage 1 (2026-07-14): pure observability —
 * records when each stage of a BUY or SELL attempt happens and turns those
 * timestamps into avg/median/p95/max stats. Deliberately mirrors metrics.ts's
 * existing convention (plain in-process singleton, not durable across
 * restarts, bounded memory) rather than adding a database table — a rolling
 * window of recent trades is all a latency report needs, and every write
 * anywhere in the trading path stays exactly as ACID/schema-stable as before.
 *
 * Every method here is a synchronous, non-throwing, no-I/O side effect (a Map
 * write or an array push) — calling `mark()` from inside a trading function
 * can never introduce a new await point, change what gets awaited, or affect
 * that function's control flow or timing-sensitive correctness. That's a
 * deliberate constraint, not an oversight: this stage adds measurement only,
 * never touches ordering/retries/locking in sendSwap, broadcastTransaction,
 * openPosition, or closePosition.
 */

export type LatencyStage =
  | 'token_detected'
  // Two-stage discovery pipeline (2026-07-22): the four checkpoints between
  // detection and the AI call, once Stage 2 (candidatePipeline.ts) runs its
  // parallel deterministic checks. 'analysis_started' is marked the instant a
  // discovery-queue worker picks the candidate up, so token_detected ->
  // analysis_started is literally queue-wait/backlog latency.
  | 'analysis_started'
  | 'dex_validated'
  | 'safety_completed'
  | 'sellability_verified'
  | 'ai_scoring_start'
  | 'ai_scoring_end'
  // Marked once the Opportunity Score is computed, right before AutoTrader's
  // per-user SnipeConfig loop begins.
  | 'decision'
  // Marked at the existing 'BUY STARTED' checkpoint, right before
  // positionManager.openPosition is called for a passing config.
  | 'buy_submitted'
  | 'filters_complete'
  | 'exit_decision'
  | 'quote_request'
  | 'quote_received'
  | 'tx_build'
  | 'tx_sign'
  | 'broadcast'
  | 'rpc_confirmation'
  | 'position_opened'
  | 'position_closed';

/** Canonical stage order per side — also what the stage-to-stage report is computed over. */
export const BUY_STAGE_ORDER: readonly LatencyStage[] = [
  'token_detected',
  'analysis_started',
  'dex_validated',
  'safety_completed',
  'sellability_verified',
  'ai_scoring_start',
  'ai_scoring_end',
  'decision',
  'buy_submitted',
  'filters_complete',
  'quote_request',
  'quote_received',
  'tx_build',
  'tx_sign',
  'broadcast',
  'rpc_confirmation',
  'position_opened',
];

export const SELL_STAGE_ORDER: readonly LatencyStage[] = [
  'exit_decision',
  'quote_request',
  'quote_received',
  'tx_build',
  'tx_sign',
  'broadcast',
  'rpc_confirmation',
  'position_closed',
];

export interface LatencyTraceMeta {
  mint?: string;
  walletId?: string;
  positionId?: string;
}

interface ActiveTrace extends LatencyTraceMeta {
  side: 'BUY' | 'SELL';
  marks: Map<LatencyStage, number>;
}

export interface CompletedTrace extends LatencyTraceMeta {
  traceId: string;
  side: 'BUY' | 'SELL';
  outcome: 'success' | 'failure';
  marks: Partial<Record<LatencyStage, number>>;
  /** Last mark timestamp minus first mark timestamp — "decision to broadcast"
   * for a trace missing later marks (e.g. a failed attempt), full pipeline
   * span for a complete one. */
  totalMs: number;
  finishedAt: number;
}

/**
 * Bounded in-process store of recent completed traces, plus the in-flight
 * ones still accumulating marks. `mark`/`finish` for an unknown or
 * already-finished traceId are silent no-ops — a caller that races with
 * itself (or that runs before `start()`, or that never had a traceId at all
 * because it came from a code path this stage doesn't instrument yet, like
 * copyTrading.ts) never throws and never corrupts another trace's data.
 */
class LatencyTracker {
  private readonly active = new Map<string, ActiveTrace>();
  private readonly completedTraces: CompletedTrace[] = [];
  private static readonly MAX_COMPLETED = 2000;

  start(traceId: string | undefined, side: 'BUY' | 'SELL', meta: LatencyTraceMeta = {}): void {
    if (!traceId || this.active.has(traceId)) return;
    this.active.set(traceId, { side, ...meta, marks: new Map() });
  }

  /** First mark for a given stage on a given trace wins — a later duplicate
   * call (e.g. a retried sub-step) never overwrites the original timing. */
  mark(traceId: string | undefined, stage: LatencyStage, timestamp: number = Date.now()): void {
    if (!traceId) return;
    const trace = this.active.get(traceId);
    if (!trace || trace.marks.has(stage)) return;
    trace.marks.set(stage, timestamp);
  }

  finish(traceId: string | undefined, outcome: 'success' | 'failure'): void {
    if (!traceId) return;
    const trace = this.active.get(traceId);
    this.active.delete(traceId);
    if (!trace || trace.marks.size === 0) return;

    const timestamps = [...trace.marks.values()];
    const record: CompletedTrace = {
      traceId,
      side: trace.side,
      mint: trace.mint,
      walletId: trace.walletId,
      positionId: trace.positionId,
      outcome,
      marks: Object.fromEntries(trace.marks) as Partial<Record<LatencyStage, number>>,
      totalMs: Math.max(...timestamps) - Math.min(...timestamps),
      finishedAt: Date.now(),
    };
    this.completedTraces.push(record);
    if (this.completedTraces.length > LatencyTracker.MAX_COMPLETED) {
      this.completedTraces.shift();
    }
  }

  getCompleted(): readonly CompletedTrace[] {
    return this.completedTraces;
  }

  /** Test-only: clears all state so tests never leak traces into each other. */
  reset(): void {
    this.active.clear();
    this.completedTraces.length = 0;
  }
}

/** One shared tracker for the whole process — same convention as eventBus/metrics/positionCloseLock. */
export const latencyTracker = new LatencyTracker();

export interface StageStats {
  count: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

/** Nearest-rank percentile over a pre-sorted-ascending array — deterministic, no interpolation needed for this use. */
function percentileOf(sortedAsc: readonly number[], p: number): number {
  const index = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[index]!;
}

function computeStats(durationsMs: readonly number[]): StageStats | undefined {
  if (durationsMs.length === 0) return undefined;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const sum = sorted.reduce((total, d) => total + d, 0);
  return {
    count: sorted.length,
    avgMs: sum / sorted.length,
    medianMs: percentileOf(sorted, 50),
    p95Ms: percentileOf(sorted, 95),
    maxMs: sorted[sorted.length - 1]!,
  };
}

export interface SideLatencyReport {
  /** Decision-to-last-observed-stage span across successful traces only — the
   * "BUY latency" / "SELL latency" figure objective 8 asks for. */
  totalStats?: StageStats;
  /** Keyed "prevStage->stage" — the per-stage breakdown objective 2 asks for. */
  stageStats: Partial<Record<string, StageStats>>;
  /**
   * Two-stage discovery pipeline (2026-07-22): the three named cross-stage
   * spans the latency objective explicitly asks for, in addition to the
   * generic adjacent-pair breakdown above — each is token_detected -> the
   * named stage, computed over every trace with both marks present (not just
   * successful ones, since a SKIP still has a real detection->decision span).
   * BUY-side only; always undefined on the SELL report (SELL traces have no
   * token_detected mark).
   */
  detectionToAnalysisMs?: StageStats;
  detectionToDecisionMs?: StageStats;
  detectionToBuySubmissionMs?: StageStats;
  successRate: number;
  fastestMs?: number;
  slowestMs?: number;
  sampleSize: number;
}

/** Detection-relative span helper for the three named cross-stage metrics above. */
function computeDetectionSpan(
  traces: readonly CompletedTrace[],
  targetStage: LatencyStage,
): StageStats | undefined {
  const durations: number[] = [];
  for (const trace of traces) {
    const from = trace.marks.token_detected;
    const to = trace.marks[targetStage];
    if (from !== undefined && to !== undefined && to >= from) {
      durations.push(to - from);
    }
  }
  return computeStats(durations);
}

export interface LatencyReport {
  buy: SideLatencyReport;
  sell: SideLatencyReport;
  generatedAt: number;
}

function buildSideReport(
  traces: readonly CompletedTrace[],
  stageOrder: readonly LatencyStage[],
): SideLatencyReport {
  const successful = traces.filter((t) => t.outcome === 'success');
  const totalDurations = successful.map((t) => t.totalMs);

  const stageStats: Partial<Record<string, StageStats>> = {};
  for (let i = 1; i < stageOrder.length; i++) {
    const prevStage = stageOrder[i - 1]!;
    const stage = stageOrder[i]!;
    const durations: number[] = [];
    for (const trace of traces) {
      const from = trace.marks[prevStage];
      const to = trace.marks[stage];
      if (from !== undefined && to !== undefined && to >= from) {
        durations.push(to - from);
      }
    }
    const stats = computeStats(durations);
    if (stats) stageStats[`${prevStage}->${stage}`] = stats;
  }

  const isBuySide = stageOrder === BUY_STAGE_ORDER;

  return {
    totalStats: computeStats(totalDurations),
    stageStats,
    detectionToAnalysisMs: isBuySide ? computeDetectionSpan(traces, 'analysis_started') : undefined,
    detectionToDecisionMs: isBuySide ? computeDetectionSpan(traces, 'decision') : undefined,
    detectionToBuySubmissionMs: isBuySide
      ? computeDetectionSpan(traces, 'buy_submitted')
      : undefined,
    successRate: traces.length > 0 ? successful.length / traces.length : 0,
    fastestMs: totalDurations.length > 0 ? Math.min(...totalDurations) : undefined,
    slowestMs: totalDurations.length > 0 ? Math.max(...totalDurations) : undefined,
    sampleSize: traces.length,
  };
}

export function computeLatencyReport(
  traces: readonly CompletedTrace[] = latencyTracker.getCompleted(),
): LatencyReport {
  return {
    buy: buildSideReport(
      traces.filter((t) => t.side === 'BUY'),
      BUY_STAGE_ORDER,
    ),
    sell: buildSideReport(
      traces.filter((t) => t.side === 'SELL'),
      SELL_STAGE_ORDER,
    ),
    generatedAt: Date.now(),
  };
}
