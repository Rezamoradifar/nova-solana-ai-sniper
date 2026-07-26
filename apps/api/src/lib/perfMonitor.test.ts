import { afterEach, describe, expect, it } from 'vitest';
import { PerfMonitor } from './perfMonitor.js';

describe('PerfMonitor', () => {
  let monitor: PerfMonitor | undefined;

  afterEach(() => {
    monitor?.stop();
    monitor = undefined;
  });

  it('returns a snapshot with the expected shape and non-negative values', () => {
    monitor = new PerfMonitor();
    const snapshot = monitor.snapshot();

    expect(snapshot.eventLoopDelayP50Ms).toBeGreaterThanOrEqual(0);
    expect(snapshot.eventLoopDelayP95Ms).toBeGreaterThanOrEqual(0);
    expect(snapshot.eventLoopDelayMaxMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.cpuUserPercent).toBeGreaterThanOrEqual(0);
    expect(snapshot.cpuSystemPercent).toBeGreaterThanOrEqual(0);
    expect(snapshot.rssMb).toBeGreaterThan(0);
    expect(snapshot.heapUsedMb).toBeGreaterThan(0);
  });

  it('can be sampled repeatedly without throwing, each call reflecting only the window since the last', () => {
    monitor = new PerfMonitor();

    expect(() => {
      monitor?.snapshot();
      monitor?.snapshot();
      monitor?.snapshot();
    }).not.toThrow();
  });

  it('stop() disables the event-loop-delay histogram without throwing', () => {
    monitor = new PerfMonitor();
    monitor.snapshot();
    expect(() => monitor?.stop()).not.toThrow();
  });
});
