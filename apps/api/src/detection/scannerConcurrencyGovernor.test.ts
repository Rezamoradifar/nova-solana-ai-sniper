import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ScannerConcurrencyGovernor,
  type ConcurrencyBoundedQueue,
} from './scannerConcurrencyGovernor.js';
import { rpcCooldownRegistry } from '../solana/resilientConnection.js';
import type { PerfMonitor, PerfSnapshot } from '../lib/perfMonitor.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakePerfSnapshot(overrides: Partial<PerfSnapshot> = {}): PerfSnapshot {
  return {
    eventLoopDelayP50Ms: 5,
    eventLoopDelayP95Ms: 10,
    eventLoopDelayMaxMs: 15,
    cpuUserPercent: 5,
    cpuSystemPercent: 1,
    rssMb: 100,
    heapUsedMb: 50,
    ...overrides,
  };
}

function fakeQueue(overrides: Partial<ConcurrencyBoundedQueue> = {}): ConcurrencyBoundedQueue {
  return {
    pending: vi.fn().mockReturnValue(0),
    active: vi.fn().mockReturnValue(0),
    processed: vi.fn().mockReturnValue(0),
    getConcurrency: vi.fn().mockReturnValue(8),
    setConcurrency: vi.fn(),
    ...overrides,
  };
}

describe('ScannerConcurrencyGovernor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpcCooldownRegistry.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    rpcCooldownRegistry.reset();
  });

  it('scales the queue up when backlogged and RPC/event-loop are healthy', () => {
    const queue = fakeQueue({
      pending: vi.fn().mockReturnValue(20),
      active: vi.fn().mockReturnValue(8),
      getConcurrency: vi.fn().mockReturnValue(8),
    });
    const perfMonitor = {
      snapshot: () => fakePerfSnapshot(),
      stop: vi.fn(),
    } as unknown as PerfMonitor;

    const governor = new ScannerConcurrencyGovernor(
      { queue, perfMonitor, logger: fakeLogger(), primaryProviderLabel: 'helius' },
      { intervalMs: 1000 },
    );
    governor.start();
    vi.advanceTimersByTime(1000);

    expect(queue.setConcurrency).toHaveBeenCalledWith(10);
    expect(governor.snapshot().lastAdjustmentReason).toBe('backlog');
    governor.stop();
  });

  it('scales down when the primary RPC provider is in an active cooldown', () => {
    rpcCooldownRegistry.record('helius', Date.now() + 60_000);
    const queue = fakeQueue({
      pending: vi.fn().mockReturnValue(20),
      active: vi.fn().mockReturnValue(8),
      getConcurrency: vi.fn().mockReturnValue(8),
    });
    const perfMonitor = {
      snapshot: () => fakePerfSnapshot(),
      stop: vi.fn(),
    } as unknown as PerfMonitor;

    const governor = new ScannerConcurrencyGovernor(
      { queue, perfMonitor, logger: fakeLogger(), primaryProviderLabel: 'helius' },
      { intervalMs: 1000 },
    );
    governor.start();
    vi.advanceTimersByTime(1000);

    expect(queue.setConcurrency).toHaveBeenCalledWith(4);
    expect(governor.snapshot().lastAdjustmentReason).toBe('rpc_pressure');
    expect(governor.snapshot().primaryRpcUnderPressure).toBe(true);
    governor.stop();
  });

  it('ignores a non-primary provider cooling down — only the configured primary label gates scaling', () => {
    // quicknode cooling down while helius (the configured primary) is fine —
    // this is the documented "expected noise" case (QuickNode daily cap).
    rpcCooldownRegistry.record('quicknode', Date.now() + 60_000);
    const queue = fakeQueue({
      pending: vi.fn().mockReturnValue(20),
      active: vi.fn().mockReturnValue(8),
      getConcurrency: vi.fn().mockReturnValue(8),
    });
    const perfMonitor = {
      snapshot: () => fakePerfSnapshot(),
      stop: vi.fn(),
    } as unknown as PerfMonitor;

    const governor = new ScannerConcurrencyGovernor(
      { queue, perfMonitor, logger: fakeLogger(), primaryProviderLabel: 'helius' },
      { intervalMs: 1000 },
    );
    governor.start();
    vi.advanceTimersByTime(1000);

    expect(governor.snapshot().lastAdjustmentReason).toBe('backlog');
    expect(governor.snapshot().primaryRpcUnderPressure).toBe(false);
    governor.stop();
  });

  it('scales down when event-loop lag exceeds the configured ceiling', () => {
    const queue = fakeQueue({ getConcurrency: vi.fn().mockReturnValue(10) });
    const perfMonitor = {
      snapshot: () => fakePerfSnapshot({ eventLoopDelayP95Ms: 500 }),
      stop: vi.fn(),
    } as unknown as PerfMonitor;

    const governor = new ScannerConcurrencyGovernor(
      { queue, perfMonitor, logger: fakeLogger(), primaryProviderLabel: 'helius' },
      { intervalMs: 1000, eventLoopLagCeilingMs: 200 },
    );
    governor.start();
    vi.advanceTimersByTime(1000);

    expect(queue.setConcurrency).toHaveBeenCalledWith(5);
    expect(governor.snapshot().lastAdjustmentReason).toBe('event_loop_lag');
    governor.stop();
  });

  it('reports throughput per minute derived from the queue.processed() delta between ticks', () => {
    let processedCount = 0;
    const queue = fakeQueue({ processed: vi.fn(() => processedCount) });
    const perfMonitor = {
      snapshot: () => fakePerfSnapshot(),
      stop: vi.fn(),
    } as unknown as PerfMonitor;

    const governor = new ScannerConcurrencyGovernor(
      { queue, perfMonitor, logger: fakeLogger(), primaryProviderLabel: 'helius' },
      { intervalMs: 10_000 },
    );
    governor.start();

    processedCount = 50; // 50 items processed over the next 10s tick window
    vi.advanceTimersByTime(10_000);

    expect(governor.snapshot().throughputPerMinute).toBe(300); // 50 per 10s -> 300/min
    governor.stop();
  });

  it('stop() disables the underlying perf monitor and clears the interval', () => {
    const queue = fakeQueue();
    const stop = vi.fn();
    const perfMonitor = { snapshot: () => fakePerfSnapshot(), stop } as unknown as PerfMonitor;
    const governor = new ScannerConcurrencyGovernor(
      { queue, perfMonitor, logger: fakeLogger(), primaryProviderLabel: 'helius' },
      { intervalMs: 1000 },
    );
    governor.start();
    vi.advanceTimersByTime(1000);
    governor.stop();

    expect(stop).toHaveBeenCalledTimes(1);
    const callsBeforeStop = (queue.setConcurrency as ReturnType<typeof vi.fn>).mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect((queue.setConcurrency as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsBeforeStop,
    );
  });
});
