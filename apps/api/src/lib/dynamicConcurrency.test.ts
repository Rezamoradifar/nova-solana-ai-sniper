import { describe, expect, it } from 'vitest';
import { computeNextConcurrency, type ConcurrencyGovernorInputs } from './dynamicConcurrency.js';

function baseInputs(overrides: Partial<ConcurrencyGovernorInputs> = {}): ConcurrencyGovernorInputs {
  return {
    pending: 0,
    active: 0,
    currentConcurrency: 8,
    minConcurrency: 2,
    maxConcurrency: 24,
    primaryRpcUnderPressure: false,
    eventLoopLagMs: 10,
    eventLoopLagCeilingMs: 200,
    ...overrides,
  };
}

describe('computeNextConcurrency', () => {
  it('halves concurrency when the primary RPC provider is under pressure', () => {
    const decision = computeNextConcurrency(
      baseInputs({
        currentConcurrency: 16,
        primaryRpcUnderPressure: true,
        pending: 50,
        active: 16,
      }),
    );
    expect(decision).toEqual({ concurrency: 8, reason: 'rpc_pressure' });
  });

  it('ignores a non-primary provider cooling down — that signal must never reach this function at all', () => {
    // primaryRpcUnderPressure: false represents "only a fallback-tier
    // provider is cooling down" — the caller (ScannerConcurrencyGovernor) is
    // responsible for that filtering; this function only ever sees the
    // already-filtered primary-only signal.
    const decision = computeNextConcurrency(
      baseInputs({
        currentConcurrency: 16,
        primaryRpcUnderPressure: false,
        pending: 50,
        active: 16,
      }),
    );
    expect(decision.reason).toBe('backlog');
    expect(decision.concurrency).toBe(18);
  });

  it('halves concurrency when event-loop lag exceeds the ceiling, even with no RPC pressure', () => {
    const decision = computeNextConcurrency(
      baseInputs({ currentConcurrency: 16, eventLoopLagMs: 250, eventLoopLagCeilingMs: 200 }),
    );
    expect(decision).toEqual({ concurrency: 8, reason: 'event_loop_lag' });
  });

  it('rpc_pressure wins over a backlog that would otherwise scale up', () => {
    const decision = computeNextConcurrency(
      baseInputs({
        currentConcurrency: 10,
        primaryRpcUnderPressure: true,
        eventLoopLagMs: 250,
        eventLoopLagCeilingMs: 200,
        pending: 100,
        active: 10,
      }),
    );
    expect(decision.reason).toBe('rpc_pressure');
  });

  it('scales up by stepUp when the queue is backlogged and nothing is under pressure', () => {
    const decision = computeNextConcurrency(
      baseInputs({ currentConcurrency: 8, pending: 20, active: 8 }),
    );
    expect(decision).toEqual({ concurrency: 10, reason: 'backlog' });
  });

  it('respects a custom stepUp', () => {
    const decision = computeNextConcurrency(
      baseInputs({ currentConcurrency: 8, pending: 20, active: 8, stepUp: 5 }),
    );
    expect(decision.concurrency).toBe(13);
  });

  it('never scales up past maxConcurrency', () => {
    const decision = computeNextConcurrency(
      baseInputs({ currentConcurrency: 23, maxConcurrency: 24, pending: 30, active: 23 }),
    );
    expect(decision).toEqual({ concurrency: 24, reason: 'backlog' });
  });

  it('never scales down past minConcurrency under RPC pressure', () => {
    const decision = computeNextConcurrency(
      baseInputs({ currentConcurrency: 3, minConcurrency: 2, primaryRpcUnderPressure: true }),
    );
    expect(decision).toEqual({ concurrency: 2, reason: 'rpc_pressure' });
  });

  it('scales down toward the floor by 1 when idle (no backlog, most capacity unused)', () => {
    const decision = computeNextConcurrency(
      baseInputs({ currentConcurrency: 10, pending: 0, active: 1 }),
    );
    expect(decision).toEqual({ concurrency: 9, reason: 'idle' });
  });

  it('never scales down past minConcurrency when idle', () => {
    const decision = computeNextConcurrency(
      baseInputs({ currentConcurrency: 2, minConcurrency: 2, pending: 0, active: 0 }),
    );
    expect(decision).toEqual({ concurrency: 2, reason: 'idle' });
  });

  it('leaves concurrency unchanged when the queue is keeping pace (pending <= active) and not idle', () => {
    const decision = computeNextConcurrency(
      baseInputs({ currentConcurrency: 8, pending: 3, active: 8 }),
    );
    expect(decision).toEqual({ concurrency: 8, reason: 'unchanged' });
  });

  it('does not treat a fully-busy queue with no backlog as idle', () => {
    // active == currentConcurrency (fully busy) and pending == 0 — this is
    // healthy saturation, not idleness, and must not scale down.
    const decision = computeNextConcurrency(
      baseInputs({ currentConcurrency: 8, pending: 0, active: 8 }),
    );
    expect(decision).toEqual({ concurrency: 8, reason: 'unchanged' });
  });
});
