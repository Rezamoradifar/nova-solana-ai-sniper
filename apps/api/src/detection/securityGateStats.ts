/**
 * Section 8/9 audit (2026-07-23, "excessive rejections + Telegram spam"
 * incident): before this, every single candidatePipeline rejection sent its
 * own Telegram alert (see candidatePipeline.ts's old notifyRejectionOnce) —
 * with ~9 rejected candidates/hour in the real 22h production sample this
 * audit analyzed, that's a constant stream of individual "🚨 Error in
 * critical security gate" pings for what is, in the overwhelming majority of
 * cases, completely normal gate behavior (a genuinely unsafe or
 * not-yet-verifiable token correctly not being bought), not a system error.
 *
 * This module is the single place that accumulates what happened to every
 * candidate since the last periodic report (see securityGateSummaryReporter.ts)
 * — a plain in-process accumulator, same convention and same durability
 * caveat as lib/metrics.ts (not persisted across restarts; this is a
 * pipeline-health signal, not a billing ledger). candidatePipeline.ts and
 * worker.ts record into it; the periodic reporter reads + resets the window.
 */
export interface SecurityGateWindowStats {
  /** New candidates that entered the pipeline for the first time (attempt 0)
   * during this window — NOT incremented again on a retry attempt. */
  scanned: number;
  /** Candidates that cleared every mandatory gate during this window (may be
   * a candidate first scanned in an earlier window, if it took retries). */
  passed: number;
  /** Candidates permanently rejected (retries exhausted or a confirmed-bad
   * reason on the very first attempt) during this window. */
  blocked: number;
  /** Per-reason count of permanent rejections during this window — mirrors
   * `blocked`'s reason lists, one increment per reason string per rejection
   * (a rejection with 3 reasons increments 3 counters). */
  blockedReasonCounts: Record<string, number>;
  /** AI-provider-side rejections (multi-LLM consensus decision !== BUY) —
   * folded into the same summary/no-individual-alert policy as the security
   * gate itself; these are also "normal, not an error" outcomes. */
  aiConsensusRejected: number;
  /** How many times a rejection was retried (i.e. classified as "couldn't
   * verify yet" and rescheduled) — a distinct candidate can contribute more
   * than one retry within a window. */
  retriesStarted: number;
  /** A candidate that needed at least one retry and then went on to pass. */
  retrySuccesses: number;
  /** Sum/count for computing the average time-to-final-resolution (pass or
   * permanent block), in ms, from a candidate's first pipeline attempt. */
  verificationLatencyMsSum: number;
  verificationLatencyCount: number;
}

function emptyWindow(): SecurityGateWindowStats {
  return {
    scanned: 0,
    passed: 0,
    blocked: 0,
    blockedReasonCounts: {},
    aiConsensusRejected: 0,
    retriesStarted: 0,
    retrySuccesses: 0,
    verificationLatencyMsSum: 0,
    verificationLatencyCount: 0,
  };
}

/** Reasons that mean a data source hasn't produced a usable answer yet, for
 * provider-unavailable-rate reporting (Section 9) — kept in sync with
 * candidatePipeline.ts's own RETRYABLE_REJECTION_REASONS superset (this list
 * is intentionally narrower: it excludes the age-dependent-but-resolved
 * reasons like holder_concentration_critical, which reflect a real, resolved
 * on-chain reading, not a provider failure). */
const PROVIDER_UNAVAILABLE_REASONS = new Set([
  'dexscreener_validation_failed',
  'holder_data_unknown',
  'mint_authority_unknown',
  'freeze_authority_unknown',
  'honeypot_check_unknown',
  'risk_analysis_failed',
  'deployer_check_failed',
  'mint_check_failed',
  'sellability_check_failed',
]);

class SecurityGateStats {
  /** Currently-in-flight retry timers — a gauge, not reset by
   * snapshotAndReset (it reflects live state, not "what happened this
   * window"). */
  private pendingGauge = 0;
  private window: SecurityGateWindowStats = emptyWindow();
  /** Cumulative totals since process start — never reset, for /metrics/security-gate. */
  private readonly cumulative: SecurityGateWindowStats = emptyWindow();

  recordScanned(): void {
    this.window.scanned += 1;
    this.cumulative.scanned += 1;
  }

  recordPassed(): void {
    this.window.passed += 1;
    this.cumulative.passed += 1;
  }

  recordBlocked(reasons: string[]): void {
    this.window.blocked += 1;
    this.cumulative.blocked += 1;
    for (const reason of reasons) {
      this.window.blockedReasonCounts[reason] = (this.window.blockedReasonCounts[reason] ?? 0) + 1;
      this.cumulative.blockedReasonCounts[reason] =
        (this.cumulative.blockedReasonCounts[reason] ?? 0) + 1;
    }
  }

  recordAiConsensusRejected(): void {
    this.window.aiConsensusRejected += 1;
    this.cumulative.aiConsensusRejected += 1;
  }

  recordRetryStarted(): void {
    this.window.retriesStarted += 1;
    this.cumulative.retriesStarted += 1;
    this.pendingGauge += 1;
  }

  /** Call exactly once per scheduled retry, when its backoff timer fires and
   * the pipeline actually re-runs (whether that run passes, blocks for good,
   * or schedules yet another retry). */
  recordRetryResolved(): void {
    this.pendingGauge = Math.max(0, this.pendingGauge - 1);
  }

  recordRetrySuccess(): void {
    this.window.retrySuccesses += 1;
    this.cumulative.retrySuccesses += 1;
  }

  recordVerificationLatency(ms: number): void {
    this.window.verificationLatencyMsSum += ms;
    this.window.verificationLatencyCount += 1;
    this.cumulative.verificationLatencyMsSum += ms;
    this.cumulative.verificationLatencyCount += 1;
  }

  /** Live count of candidates currently sitting in a scheduled retry
   * backoff — a snapshot, not a windowed count (see pendingGauge's own doc
   * comment). */
  pendingCount(): number {
    return this.pendingGauge;
  }

  providerUnavailableCount(stats: SecurityGateWindowStats): number {
    let total = 0;
    for (const [reason, count] of Object.entries(stats.blockedReasonCounts)) {
      if (PROVIDER_UNAVAILABLE_REASONS.has(reason)) total += count;
    }
    return total;
  }

  averageVerificationLatencyMs(stats: SecurityGateWindowStats): number | undefined {
    if (stats.verificationLatencyCount === 0) return undefined;
    return stats.verificationLatencyMsSum / stats.verificationLatencyCount;
  }

  retrySuccessRate(stats: SecurityGateWindowStats): number | undefined {
    if (stats.retriesStarted === 0) return undefined;
    return stats.retrySuccesses / stats.retriesStarted;
  }

  /** Read + reset the reporting window — called by the periodic 15-minute
   * summary reporter. */
  snapshotAndReset(): SecurityGateWindowStats {
    const snapshot = this.window;
    this.window = emptyWindow();
    return snapshot;
  }

  /** Non-resetting cumulative view, for /metrics/security-gate. */
  cumulativeSnapshot(): SecurityGateWindowStats {
    return {
      ...this.cumulative,
      blockedReasonCounts: { ...this.cumulative.blockedReasonCounts },
    };
  }

  /** Test-only: clears all state so tests never leak into each other — same
   * convention as candidatePipeline.ts's old resetRejectionAlertDedupCache. */
  resetForTests(): void {
    this.pendingGauge = 0;
    this.window = emptyWindow();
    Object.assign(this.cumulative, emptyWindow());
  }
}

export const securityGateStats = new SecurityGateStats();
