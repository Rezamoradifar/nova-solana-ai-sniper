import type { Logger } from '@nova/shared';
import { rpcCooldownRegistry } from '../solana/resilientConnection.js';
import {
  computeNextConcurrency,
  type ConcurrencyAdjustmentReason,
} from '../lib/dynamicConcurrency.js';
import type { PerfMonitor, PerfSnapshot } from '../lib/perfMonitor.js';

/** The subset of PriorityConcurrencyQueue<T> this governor needs — kept as a
 * narrow interface rather than importing the generic class so this file
 * doesn't need to know the queue's payload type. */
export interface ConcurrencyBoundedQueue {
  pending(): number;
  active(): number;
  processed(): number;
  getConcurrency(): number;
  setConcurrency(n: number): void;
}

export interface ScannerConcurrencyGovernorDeps {
  queue: ConcurrencyBoundedQueue;
  perfMonitor: PerfMonitor;
  logger: Logger;
  /**
   * Ordered RPC endpoint labels, primary(-preferred) first — see
   * connection.ts's resolveAllRpcEndpoints(). Only this label's cooldown
   * state gates scaling; a non-primary provider cooling down is expected,
   * routine noise (e.g. QuickNode's documented daily-cap behavior) and must
   * never throttle the whole scanner down.
   */
  primaryProviderLabel: string;
}

export interface ScannerConcurrencyGovernorOptions {
  intervalMs?: number;
  minConcurrency?: number;
  maxConcurrency?: number;
  eventLoopLagCeilingMs?: number;
  stepUp?: number;
}

export interface ScannerConcurrencyGovernorSnapshot {
  concurrency: number;
  bounds: { min: number; max: number };
  lastAdjustmentReason: ConcurrencyAdjustmentReason;
  pending: number;
  active: number;
  throughputPerMinute: number;
  perf: PerfSnapshot | null;
  primaryProviderLabel: string;
  primaryRpcUnderPressure: boolean;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_MIN_CONCURRENCY = 2;
const DEFAULT_MAX_CONCURRENCY = 24;
const DEFAULT_EVENT_LOOP_LAG_CEILING_MS = 200;

/**
 * Massive Scanner Scalability (Phase 2, 2026-07-26): periodically re-tunes
 * discoveryQueue's concurrency limit from live signals instead of leaving it
 * fixed at DISCOVERY_QUEUE_CONCURRENCY for the process's entire lifetime.
 * Same start/stop/interval convention as every other coordinator in this
 * directory (ScannerHealthCoordinator, FallbackLaunchDiscovery) — a single
 * setInterval, re-entrancy is a non-issue here since each tick is
 * synchronous (no await), unlike those two.
 */
export class ScannerConcurrencyGovernor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentConcurrency: number;
  private lastReason: ConcurrencyAdjustmentReason = 'unchanged';
  private lastProcessedAtTick: number;
  private lastThroughputPerMinute = 0;
  private lastPerfSnapshot: PerfSnapshot | null = null;
  private lastPrimaryRpcUnderPressure = false;
  private readonly intervalMs: number;
  private readonly minConcurrency: number;
  private readonly maxConcurrency: number;
  private readonly eventLoopLagCeilingMs: number;
  private readonly stepUp: number | undefined;

  constructor(
    private readonly deps: ScannerConcurrencyGovernorDeps,
    options: ScannerConcurrencyGovernorOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.minConcurrency = options.minConcurrency ?? DEFAULT_MIN_CONCURRENCY;
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.eventLoopLagCeilingMs = options.eventLoopLagCeilingMs ?? DEFAULT_EVENT_LOOP_LAG_CEILING_MS;
    this.stepUp = options.stepUp;
    this.currentConcurrency = Math.min(
      this.maxConcurrency,
      Math.max(this.minConcurrency, deps.queue.getConcurrency()),
    );
    this.lastProcessedAtTick = deps.queue.processed();
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.deps.perfMonitor.stop();
  }

  private tick(): void {
    const perf = this.deps.perfMonitor.snapshot();
    this.lastPerfSnapshot = perf;

    const cooldownUntil = rpcCooldownRegistry.snapshot()[this.deps.primaryProviderLabel];
    const primaryRpcUnderPressure = cooldownUntil !== undefined && cooldownUntil > Date.now();
    this.lastPrimaryRpcUnderPressure = primaryRpcUnderPressure;

    const processedNow = this.deps.queue.processed();
    this.lastThroughputPerMinute = Math.round(
      ((processedNow - this.lastProcessedAtTick) / this.intervalMs) * 60_000,
    );
    this.lastProcessedAtTick = processedNow;

    const decision = computeNextConcurrency({
      pending: this.deps.queue.pending(),
      active: this.deps.queue.active(),
      currentConcurrency: this.currentConcurrency,
      minConcurrency: this.minConcurrency,
      maxConcurrency: this.maxConcurrency,
      primaryRpcUnderPressure,
      eventLoopLagMs: perf.eventLoopDelayP95Ms,
      eventLoopLagCeilingMs: this.eventLoopLagCeilingMs,
      ...(this.stepUp !== undefined ? { stepUp: this.stepUp } : {}),
    });

    if (decision.concurrency !== this.currentConcurrency) {
      this.deps.logger.info(
        {
          from: this.currentConcurrency,
          to: decision.concurrency,
          reason: decision.reason,
          pending: this.deps.queue.pending(),
          active: this.deps.queue.active(),
          eventLoopDelayP95Ms: perf.eventLoopDelayP95Ms,
          primaryRpcUnderPressure,
        },
        'ScannerConcurrencyGovernor adjusted discoveryQueue concurrency',
      );
    }
    this.currentConcurrency = decision.concurrency;
    this.lastReason = decision.reason;
    this.deps.queue.setConcurrency(this.currentConcurrency);
  }

  snapshot(): ScannerConcurrencyGovernorSnapshot {
    return {
      concurrency: this.currentConcurrency,
      bounds: { min: this.minConcurrency, max: this.maxConcurrency },
      lastAdjustmentReason: this.lastReason,
      pending: this.deps.queue.pending(),
      active: this.deps.queue.active(),
      throughputPerMinute: this.lastThroughputPerMinute,
      perf: this.lastPerfSnapshot,
      primaryProviderLabel: this.deps.primaryProviderLabel,
      primaryRpcUnderPressure: this.lastPrimaryRpcUnderPressure,
    };
  }
}
