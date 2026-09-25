import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MonitorWatchdog, type RestartableMonitor } from './monitorWatchdog.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeMonitor(): RestartableMonitor<{ n: number }> & {
  starts: number;
  stops: number;
  handler: ((event: { n: number }) => void) | undefined;
} {
  const m = {
    starts: 0,
    stops: 0,
    handler: undefined as ((event: { n: number }) => void) | undefined,
    start(onEvent: (event: { n: number }) => void) {
      m.starts += 1;
      m.handler = onEvent;
    },
    stop() {
      m.stops += 1;
      m.handler = undefined;
    },
  };
  return m;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MonitorWatchdog', () => {
  it('forwards raw activity to the caller and counts it as liveness', async () => {
    let raw: (() => void) | undefined;
    let starts = 0;
    const monitor: RestartableMonitor<{ n: number }> = {
      start(_onEvent, onRawActivity) {
        starts += 1;
        raw = onRawActivity;
      },
      stop() {},
    };
    const onRawActivity = vi.fn();
    const watchdog = new MonitorWatchdog(monitor, fakeLogger() as never, {
      label: 'test',
      idleThresholdMs: 10_000,
      checkIntervalMs: 1_000,
    });
    watchdog.start(vi.fn(), onRawActivity);

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      raw!();
    }

    expect(onRawActivity).toHaveBeenCalledTimes(5);
    expect(starts).toBe(1);
    await watchdog.stop();
  });

  it('starts the wrapped monitor exactly once and forwards events', () => {
    const monitor = fakeMonitor();
    const onEvent = vi.fn();
    const watchdog = new MonitorWatchdog(monitor, fakeLogger() as never, {
      label: 'test',
      idleThresholdMs: 10_000,
    });

    watchdog.start(onEvent);
    expect(monitor.starts).toBe(1);

    monitor.handler!({ n: 1 });
    expect(onEvent).toHaveBeenCalledWith({ n: 1 });
  });

  it('does not restart the subscription while events keep arriving within the idle threshold', async () => {
    const monitor = fakeMonitor();
    const watchdog = new MonitorWatchdog(monitor, fakeLogger() as never, {
      label: 'test',
      idleThresholdMs: 10_000,
      checkIntervalMs: 1_000,
    });
    watchdog.start(vi.fn());

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      monitor.handler!({ n: i });
    }

    expect(monitor.starts).toBe(1);
    expect(monitor.stops).toBe(0);
  });

  it('force-restarts (stop then start) when no event arrives within the idle threshold', async () => {
    const monitor = fakeMonitor();
    const logger = fakeLogger();
    const watchdog = new MonitorWatchdog(monitor, logger as never, {
      label: 'pump.fun',
      idleThresholdMs: 10_000,
      checkIntervalMs: 1_000,
    });
    watchdog.start(vi.fn());

    await vi.advanceTimersByTimeAsync(11_000);

    expect(monitor.stops).toBe(1);
    expect(monitor.starts).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'pump.fun' }),
      expect.stringContaining('MONITOR WATCHDOG'),
    );
  });

  it('keeps working after a forced restart — new events reset the idle clock again', async () => {
    const monitor = fakeMonitor();
    const watchdog = new MonitorWatchdog(monitor, fakeLogger() as never, {
      label: 'test',
      idleThresholdMs: 10_000,
      checkIntervalMs: 1_000,
    });
    watchdog.start(vi.fn());

    await vi.advanceTimersByTimeAsync(11_000);
    expect(monitor.starts).toBe(2);

    monitor.handler!({ n: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(monitor.starts).toBe(2); // no second restart yet, event kept it alive
  });

  it('restarts anyway if stop() throws, so a bad stop cannot wedge the watchdog forever', async () => {
    const monitor = fakeMonitor();
    monitor.stop = vi.fn(() => {
      throw new Error('boom');
    });
    const logger = fakeLogger();
    const watchdog = new MonitorWatchdog(monitor, logger as never, {
      label: 'test',
      idleThresholdMs: 10_000,
      checkIntervalMs: 1_000,
    });
    watchdog.start(vi.fn());

    await vi.advanceTimersByTimeAsync(11_000);

    expect(monitor.starts).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'test' }),
      expect.stringContaining('stop() before restart failed'),
    );
  });

  it('stop() clears the check interval and stops the wrapped monitor', async () => {
    const monitor = fakeMonitor();
    const watchdog = new MonitorWatchdog(monitor, fakeLogger() as never, {
      label: 'test',
      idleThresholdMs: 10_000,
      checkIntervalMs: 1_000,
    });
    watchdog.start(vi.fn());

    await watchdog.stop();
    expect(monitor.stops).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.starts).toBe(1); // no restart after stop() — interval was cleared
  });
});
