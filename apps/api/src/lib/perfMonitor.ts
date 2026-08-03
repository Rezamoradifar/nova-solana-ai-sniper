import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/**
 * Massive Scanner Scalability (Phase 2, 2026-07-26): this codebase had zero
 * CPU/RAM/event-loop observability before this. Everything — the HTTP
 * server plus every scanner/monitor/queue loop in worker.ts — runs in one
 * Node process (see ecosystem.config.cjs: `exec_mode: 'fork'`,
 * `instances: 1`; nothing here is multi-process or multi-threaded), so
 * event-loop delay is the single most direct "is this process falling
 * behind under load" signal available — more so than raw CPU% alone, which
 * doesn't distinguish "busy doing useful work" from "busy because something
 * is blocking." Built entirely on Node's own `perf_hooks`/`process` APIs —
 * no new dependency, matching this codebase's existing "plain in-process
 * counters, no APM" convention (see lib/metrics.ts's own doc comment).
 */
export interface PerfSnapshot {
  eventLoopDelayP50Ms: number;
  eventLoopDelayP95Ms: number;
  eventLoopDelayMaxMs: number;
  /** Percent of one CPU core consumed since the previous snapshot (or since
   * construction, for the first call). Can exceed 100 only if genuinely
   * multi-core-bound, which nothing in this single-threaded pipeline is. */
  cpuUserPercent: number;
  cpuSystemPercent: number;
  rssMb: number;
  heapUsedMb: number;
}

export class PerfMonitor {
  private readonly histogram: IntervalHistogram;
  private lastCpuUsage: NodeJS.CpuUsage;
  private lastSampledAtMs: number;

  constructor() {
    this.histogram = monitorEventLoopDelay({ resolution: 10 });
    this.histogram.enable();
    this.lastCpuUsage = process.cpuUsage();
    this.lastSampledAtMs = Date.now();
  }

  stop(): void {
    this.histogram.disable();
  }

  /**
   * Resets the event-loop-delay histogram on every call so each snapshot
   * reflects only the period since it was last read, not a stale all-time
   * distribution — same "since last read, not since forever" convention as
   * resilientConnection.ts's RpcRequestCounters.attemptsPerSecondByProvider.
   * Callers must not call this more often than they intend to consume a
   * fresh window (see scannerConcurrencyGovernor.ts, the one place this is
   * sampled — its own snapshot() returns the last-computed value rather than
   * re-sampling, specifically to avoid a second, unrelated caller silently
   * truncating the governor's own measurement window).
   */
  snapshot(): PerfSnapshot {
    const nowMs = Date.now();
    const elapsedMs = Math.max(nowMs - this.lastSampledAtMs, 1);
    const cpuUsage = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();
    this.lastSampledAtMs = nowMs;

    const mem = process.memoryUsage();
    const snapshot: PerfSnapshot = {
      eventLoopDelayP50Ms: this.histogram.percentile(50) / 1e6,
      eventLoopDelayP95Ms: this.histogram.percentile(95) / 1e6,
      eventLoopDelayMaxMs: this.histogram.max / 1e6,
      // cpuUsage() reports microseconds of CPU time consumed; dividing by
      // the elapsed wall-clock window (also in microseconds) gives a 0-100+
      // percent-of-one-core figure.
      cpuUserPercent: Math.round((cpuUsage.user / 1000 / elapsedMs) * 1000) / 10,
      cpuSystemPercent: Math.round((cpuUsage.system / 1000 / elapsedMs) * 1000) / 10,
      rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
      heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
    };
    this.histogram.reset();
    return snapshot;
  }
}
