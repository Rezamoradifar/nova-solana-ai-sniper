import type { Logger } from '@nova/shared';
import type { NotificationService, SecurityGateSummaryReport } from '@nova/telegram-bot';
import { securityGateStats } from '../detection/securityGateStats.js';

/**
 * Section 8 (2026-07-23 audit): the one place that turns the last 15 minutes
 * of candidatePipeline.ts activity into a single Telegram message, replacing
 * the old per-rejection alert. Skips sending entirely when nothing happened
 * in the window (e.g. every discovery source idle) — an empty report every
 * 15 minutes would just be a different flavor of noise.
 */
export class SecurityGateSummaryReporter {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly notifier: NotificationService | undefined,
    private readonly logger: Logger,
  ) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reportOnce();
    }, intervalMs);
    // Never keeps the process alive on its own — same convention as every
    // other interval-based monitor in this codebase (see priceMonitor.ts).
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async reportOnce(): Promise<void> {
    const window = securityGateStats.snapshotAndReset();
    const totalActivity =
      window.scanned + window.passed + window.blocked + window.aiConsensusRejected;
    if (totalActivity === 0) return;

    const report: SecurityGateSummaryReport = {
      candidatesScanned: window.scanned,
      passedSecurity: window.passed,
      pendingVerification: securityGateStats.pendingCount(),
      blocked: window.blocked,
      blockedReasonCounts: window.blockedReasonCounts,
      aiConsensusRejected: window.aiConsensusRejected,
      providerUnavailableCount: securityGateStats.providerUnavailableCount(window),
      averageVerificationLatencyMs: securityGateStats.averageVerificationLatencyMs(window),
      retrySuccessRate: securityGateStats.retrySuccessRate(window),
    };

    try {
      await this.notifier?.notifySecurityGateSummary(report);
    } catch (err) {
      this.logger.warn({ err }, 'security gate summary: failed to send Telegram report');
    }
  }
}
