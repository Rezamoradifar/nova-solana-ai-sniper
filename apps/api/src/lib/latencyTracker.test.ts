import { describe, expect, it, beforeEach } from 'vitest';
import { latencyTracker, computeLatencyReport, type CompletedTrace } from './latencyTracker.js';

beforeEach(() => {
  latencyTracker.reset();
});

describe('LatencyTracker lifecycle', () => {
  it('records a completed trace with the correct span and marks', () => {
    latencyTracker.start('t1', 'BUY', { mint: 'MintA', walletId: 'wallet-1' });
    latencyTracker.mark('t1', 'token_detected', 1000);
    latencyTracker.mark('t1', 'filters_complete', 1050);
    latencyTracker.mark('t1', 'broadcast', 1200);
    latencyTracker.finish('t1', 'success');

    const [trace] = latencyTracker.getCompleted();
    expect(trace).toMatchObject({
      traceId: 't1',
      side: 'BUY',
      mint: 'MintA',
      walletId: 'wallet-1',
      outcome: 'success',
      totalMs: 200,
      marks: { token_detected: 1000, filters_complete: 1050, broadcast: 1200 },
    });
  });

  it('is a fully safe no-op for every method when traceId is undefined', () => {
    expect(() => {
      latencyTracker.start(undefined, 'BUY');
      latencyTracker.mark(undefined, 'token_detected');
      latencyTracker.finish(undefined, 'success');
    }).not.toThrow();
    expect(latencyTracker.getCompleted()).toHaveLength(0);
  });

  it('mark() on an unknown or already-finished traceId is silently dropped, never throws', () => {
    expect(() => latencyTracker.mark('never-started', 'token_detected')).not.toThrow();

    latencyTracker.start('t2', 'SELL');
    latencyTracker.mark('t2', 'exit_decision', 1000);
    latencyTracker.finish('t2', 'success');
    // t2 is no longer active — a late mark for it must not resurrect or corrupt it.
    latencyTracker.mark('t2', 'broadcast', 5000);

    const traces = latencyTracker.getCompleted();
    expect(traces).toHaveLength(1);
    expect(traces[0]!.marks.broadcast).toBeUndefined();
  });

  it('the first mark for a given stage wins — a later duplicate call never overwrites it', () => {
    latencyTracker.start('t3', 'BUY');
    latencyTracker.mark('t3', 'quote_request', 1000);
    latencyTracker.mark('t3', 'quote_request', 9999);
    latencyTracker.mark('t3', 'quote_received', 1100);
    latencyTracker.finish('t3', 'success');

    expect(latencyTracker.getCompleted()[0]!.marks.quote_request).toBe(1000);
  });

  it('finish() with zero marks records nothing (start() immediately followed by finish())', () => {
    latencyTracker.start('t4', 'BUY');
    latencyTracker.finish('t4', 'failure');
    expect(latencyTracker.getCompleted()).toHaveLength(0);
  });

  it('bounds memory: pushes past the 2000-trace window drop the oldest first', () => {
    for (let i = 0; i < 2005; i++) {
      const id = `bulk-${i}`;
      latencyTracker.start(id, 'BUY');
      latencyTracker.mark(id, 'token_detected', i);
      latencyTracker.finish(id, 'success');
    }
    const traces = latencyTracker.getCompleted();
    expect(traces).toHaveLength(2000);
    expect(traces[0]!.traceId).toBe('bulk-5'); // the first 5 were evicted
    expect(traces[traces.length - 1]!.traceId).toBe('bulk-2004');
  });

  it('re-entrant start() for an already-active traceId never clobbers its accumulated marks', () => {
    latencyTracker.start('t5', 'BUY', { mint: 'MintA' });
    latencyTracker.mark('t5', 'token_detected', 1000);
    latencyTracker.start('t5', 'SELL', { mint: 'MintB' }); // should be ignored
    latencyTracker.mark('t5', 'filters_complete', 1050);
    latencyTracker.finish('t5', 'success');

    const [trace] = latencyTracker.getCompleted();
    expect(trace!.side).toBe('BUY');
    expect(trace!.mint).toBe('MintA');
    expect(trace!.marks.token_detected).toBe(1000);
  });
});

describe('computeLatencyReport', () => {
  function makeTrace(overrides: Partial<CompletedTrace>): CompletedTrace {
    return {
      traceId: 'x',
      side: 'BUY',
      outcome: 'success',
      marks: {},
      totalMs: 0,
      finishedAt: Date.now(),
      ...overrides,
    };
  }

  it('computes avg/median/p95/max per stage transition, separately for BUY and SELL', () => {
    // Five BUY traces with quote_request->quote_received deltas: 100,200,300,400,500ms.
    const buyTraces = [100, 200, 300, 400, 500].map((delta, i) =>
      makeTrace({
        traceId: `buy-${i}`,
        totalMs: delta,
        marks: { quote_request: 0, quote_received: delta },
      }),
    );
    const sellTraces = [50, 60].map((delta, i) =>
      makeTrace({
        traceId: `sell-${i}`,
        side: 'SELL',
        totalMs: delta,
        marks: { exit_decision: 0, quote_request: delta },
      }),
    );

    const report = computeLatencyReport([...buyTraces, ...sellTraces]);

    const stage = report.buy.stageStats['quote_request->quote_received']!;
    expect(stage.count).toBe(5);
    expect(stage.avgMs).toBe(300);
    expect(stage.medianMs).toBe(300);
    expect(stage.maxMs).toBe(500);
    expect(stage.p95Ms).toBe(500);

    expect(report.sell.stageStats['exit_decision->quote_request']!.count).toBe(2);
    // The BUY-only stage transition must never leak into the SELL report.
    expect(report.sell.stageStats['quote_request->quote_received']).toBeUndefined();
  });

  it('computes overall totalStats/fastest/slowest from successful traces only', () => {
    const traces = [
      makeTrace({ traceId: 'a', outcome: 'success', totalMs: 300 }),
      makeTrace({ traceId: 'b', outcome: 'success', totalMs: 100 }),
      makeTrace({ traceId: 'c', outcome: 'failure', totalMs: 9999 }), // must be excluded
    ];
    const report = computeLatencyReport(traces);

    expect(report.buy.fastestMs).toBe(100);
    expect(report.buy.slowestMs).toBe(300);
    expect(report.buy.totalStats?.avgMs).toBe(200);
  });

  it('computes successRate over all traces including failures', () => {
    const traces = [
      makeTrace({ traceId: 'a', outcome: 'success' }),
      makeTrace({ traceId: 'b', outcome: 'success' }),
      makeTrace({ traceId: 'c', outcome: 'failure' }),
      makeTrace({ traceId: 'd', outcome: 'failure' }),
    ];
    expect(computeLatencyReport(traces).buy.successRate).toBe(0.5);
  });

  it('returns undefined stats (not NaN or a crash) when there is no data at all', () => {
    const report = computeLatencyReport([]);
    expect(report.buy.totalStats).toBeUndefined();
    expect(report.buy.successRate).toBe(0);
    expect(report.buy.fastestMs).toBeUndefined();
    expect(Object.keys(report.buy.stageStats)).toHaveLength(0);
  });

  it('never counts a stage pair where the "to" mark is missing or precedes the "from" mark', () => {
    const traces = [
      makeTrace({ traceId: 'a', marks: { broadcast: 1000 } }), // missing rpc_confirmation
      makeTrace({ traceId: 'b', marks: { broadcast: 1000, rpc_confirmation: 900 } }), // out of order — dropped
      makeTrace({ traceId: 'c', marks: { broadcast: 1000, rpc_confirmation: 1500 } }), // valid
    ];
    const report = computeLatencyReport(traces);
    expect(report.buy.stageStats['broadcast->rpc_confirmation']!.count).toBe(1);
    expect(report.buy.stageStats['broadcast->rpc_confirmation']!.avgMs).toBe(500);
  });
});
