import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SourceHealthMonitor } from './sourceHealthMonitor.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SourceHealthMonitor', () => {
  it('does not alert while every source has recent activity', async () => {
    const logger = fakeLogger();
    const onAlert = vi.fn();
    const monitor = new SourceHealthMonitor(
      ['PUMPFUN', 'METEORA'],
      30 * 60 * 1000,
      logger,
      onAlert,
    );
    monitor.start(1000);

    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(20 * 60 * 1000);
      await vi.runOnlyPendingTimersAsync();
      monitor.recordActivity('PUMPFUN');
      monitor.recordActivity('METEORA');
    }

    expect(onAlert).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('alerts exactly once when a source is silent past the threshold', async () => {
    const logger = fakeLogger();
    const onAlert = vi.fn();
    const monitor = new SourceHealthMonitor(['METEORA'], 30 * 60 * 1000, logger, onAlert);
    monitor.start(1000);

    vi.advanceTimersByTime(31 * 60 * 1000);
    await vi.runOnlyPendingTimersAsync();

    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'METEORA', silentForMs: expect.any(Number) }),
    );

    // Further ticks while still silent must not re-alert.
    vi.advanceTimersByTime(10 * 60 * 1000);
    await vi.runOnlyPendingTimersAsync();
    expect(onAlert).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('re-alerts after recovering and going silent a second time', async () => {
    const logger = fakeLogger();
    const onAlert = vi.fn();
    const monitor = new SourceHealthMonitor(['ORCA'], 30 * 60 * 1000, logger, onAlert);
    monitor.start(1000);

    vi.advanceTimersByTime(31 * 60 * 1000);
    await vi.runOnlyPendingTimersAsync();
    expect(onAlert).toHaveBeenCalledTimes(1);

    monitor.recordActivity('ORCA');
    vi.advanceTimersByTime(31 * 60 * 1000);
    await vi.runOnlyPendingTimersAsync();
    expect(onAlert).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it('tracks each configured source independently', async () => {
    const logger = fakeLogger();
    const onAlert = vi.fn();
    const monitor = new SourceHealthMonitor(
      ['PUMPFUN', 'METEORA'],
      30 * 60 * 1000,
      logger,
      onAlert,
    );
    monitor.start(1000);

    vi.advanceTimersByTime(20 * 60 * 1000);
    monitor.recordActivity('PUMPFUN');
    vi.advanceTimersByTime(15 * 60 * 1000);
    await vi.runOnlyPendingTimersAsync();

    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith(expect.objectContaining({ source: 'METEORA' }));
    monitor.stop();
  });
});
