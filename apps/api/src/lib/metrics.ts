/**
 * Plain in-process counters — there is no Prometheus/StatsD wiring in this
 * codebase today, and this feature only needs enough observability to answer
 * "is the Telegram trend source actually saving RPC/AI spend." Not durable
 * across restarts; that's fine for a pipeline-health signal, not billing.
 */
export interface MetricsSnapshot {
  telegramSignalsReceived: number;
  mintsExtracted: number;
  duplicateRejected: number;
  blacklistRejected: number;
  liquidityZeroRejected: number;
  aiRejected: number;
  qualifiedOpportunities: number;
  executedTrades: number;
  /** Estimated Helius RPC calls avoided by rejecting a candidate before the
   * full RiskAnalyzer.analyze() (mint-authority + holder-concentration) runs. */
  rpcCallsSavedEstimate: number;
  /** Notify gate (notifyGate.ts) — applied to every detection source, on-chain
   * and Telegram alike, in worker.ts's shared notifyAndAutoTrade.
   * launchNotificationsSuppressed is the direct "before vs after" number for
   * this fix: it's exactly how many New Launch/AI High Score alerts would
   * have gone out under the old unconditional-notify behavior but didn't. */
  launchNotificationsSent: number;
  launchNotificationsSuppressed: number;
}

type Counter = keyof MetricsSnapshot;

class Metrics {
  private readonly counters: MetricsSnapshot = {
    telegramSignalsReceived: 0,
    mintsExtracted: 0,
    duplicateRejected: 0,
    blacklistRejected: 0,
    liquidityZeroRejected: 0,
    aiRejected: 0,
    qualifiedOpportunities: 0,
    executedTrades: 0,
    rpcCallsSavedEstimate: 0,
    launchNotificationsSent: 0,
    launchNotificationsSuppressed: 0,
  };

  increment(counter: Counter, by = 1): void {
    this.counters[counter] += by;
  }

  snapshot(): MetricsSnapshot {
    return { ...this.counters };
  }
}

export const metrics = new Metrics();
