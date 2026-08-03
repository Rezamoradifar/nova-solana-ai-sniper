import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { securityGateStats } from '../detection/securityGateStats.js';
import { SecurityGateSummaryReporter } from './securityGateSummaryReporter.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

beforeEach(() => {
  securityGateStats.resetForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SecurityGateSummaryReporter', () => {
  it('sends nothing when the window is completely idle', async () => {
    const notifySecurityGateSummary = vi.fn().mockResolvedValue(undefined);
    const reporter = new SecurityGateSummaryReporter(
      { notifySecurityGateSummary } as never,
      fakeLogger(),
    );

    reporter.start(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(notifySecurityGateSummary).not.toHaveBeenCalled();
    reporter.stop();
  });

  it('reports the accumulated window and resets it once activity happened', async () => {
    const notifySecurityGateSummary = vi.fn().mockResolvedValue(undefined);
    const reporter = new SecurityGateSummaryReporter(
      { notifySecurityGateSummary } as never,
      fakeLogger(),
    );
    securityGateStats.recordScanned();
    securityGateStats.recordBlocked(['honeypot_suspected']);

    reporter.start(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(notifySecurityGateSummary).toHaveBeenCalledTimes(1);
    const report = notifySecurityGateSummary.mock.calls[0]![0];
    expect(report.candidatesScanned).toBe(1);
    expect(report.blocked).toBe(1);
    expect(report.blockedReasonCounts).toEqual({ honeypot_suspected: 1 });

    // Window reset after the report — a second tick with nothing new sends nothing.
    await vi.advanceTimersByTimeAsync(1000);
    expect(notifySecurityGateSummary).toHaveBeenCalledTimes(1);
    reporter.stop();
  });

  it('logs a warning instead of throwing when the Telegram send fails', async () => {
    const notifySecurityGateSummary = vi.fn().mockRejectedValue(new Error('telegram down'));
    const logger = fakeLogger();
    const reporter = new SecurityGateSummaryReporter(
      { notifySecurityGateSummary } as never,
      logger,
    );
    securityGateStats.recordPassed();

    reporter.start(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledTimes(1);
    reporter.stop();
  });

  it('start() is idempotent and stop() prevents further reports', async () => {
    const notifySecurityGateSummary = vi.fn().mockResolvedValue(undefined);
    const reporter = new SecurityGateSummaryReporter(
      { notifySecurityGateSummary } as never,
      fakeLogger(),
    );

    reporter.start(1000);
    reporter.start(1000);
    reporter.stop();
    securityGateStats.recordPassed();
    await vi.advanceTimersByTimeAsync(5000);

    expect(notifySecurityGateSummary).not.toHaveBeenCalled();
  });
});
