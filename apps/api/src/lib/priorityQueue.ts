export type QueuePriority = 'FAST_PATH' | 'NORMAL';

/**
 * Two-stage discovery pipeline (2026-07-22): a bounded-concurrency,
 * two-tier FIFO queue. Used for both (1) the handoff between a WS scanner
 * callback and the bounded pool of workers that actually run the expensive
 * per-candidate pipeline, and (2) gating calls to the (rate-limited, slower)
 * AI provider so a momentum-flagged ("FAST_PATH") candidate's AI call jumps
 * ahead of ordinary candidates still waiting for theirs. Same class, two
 * instances — the two use cases differ only in payload type and concurrency
 * limit, not in queueing semantics.
 *
 * `enqueue` is synchronous and never throws, so a scanner callback can call
 * it and return immediately with no await — exactly "push into an async
 * queue immediately," never "run expensive work inside the callback." A
 * handler that rejects (or throws synchronously) is caught and logged here,
 * never propagated — one bad candidate must never take down the pump or any
 * other queued item.
 */
export class PriorityConcurrencyQueue<T> {
  private readonly fastPath: T[] = [];
  private readonly normal: T[] = [];
  private running = 0;
  private concurrency: number;
  // Massive Scanner Scalability (Phase 2, 2026-07-26): total items drained
  // (handler settled, success or failure alike) since construction — the
  // queue's own throughput counter. A dynamic-concurrency governor (see
  // detection/scannerConcurrencyGovernor.ts) diffs this over time to compute
  // items/sec; nothing here reads the clock itself, same "just count, let
  // the caller derive a rate" convention as lib/metrics.ts.
  private processedCount = 0;

  constructor(
    concurrency: number,
    private readonly handler: (item: T) => Promise<void>,
    private readonly onError: (err: unknown, item: T) => void = () => {},
  ) {
    this.concurrency = concurrency;
  }

  enqueue(item: T, priority: QueuePriority = 'NORMAL'): void {
    if (priority === 'FAST_PATH') {
      this.fastPath.push(item);
    } else {
      this.normal.push(item);
    }
    this.pump();
  }

  /** Total items waiting for a worker slot — does not include items currently running. */
  pending(): number {
    return this.fastPath.length + this.normal.length;
  }

  /** Items actively being processed right now. */
  active(): number {
    return this.running;
  }

  /** Total items drained since construction — see processedCount's doc comment. */
  processed(): number {
    return this.processedCount;
  }

  /** Current worker-slot limit. */
  getConcurrency(): number {
    return this.concurrency;
  }

  /**
   * Massive Scanner Scalability (Phase 2, 2026-07-26): lets a governor adjust
   * capacity at runtime instead of the fixed value this queue was
   * constructed with — e.g. scale up while the queue is backlogged and RPC
   * capacity is healthy, scale down the moment it isn't. Silently clamps to
   * at least 1 (a concurrency of 0 would permanently stall the queue) rather
   * than throwing, since a governor's computed value is defensive-clamped
   * upstream too (see dynamicConcurrency.ts) and this must never be the
   * reason a candidate stops being processed. Immediately pumps so a
   * same-tick increase can start new work right away instead of waiting for
   * the next enqueue/completion event.
   */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.floor(n));
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const item = this.fastPath.shift() ?? this.normal.shift();
      if (item === undefined) return;

      this.running++;
      // `handler` may reject asynchronously OR throw synchronously (e.g. a
      // non-async handler) — Promise.resolve().then(...) normalizes both into
      // the same rejection path so enqueue() can never throw either way.
      Promise.resolve()
        .then(() => this.handler(item))
        .catch((err: unknown) => this.onError(err, item))
        .finally(() => {
          this.running--;
          this.processedCount++;
          this.pump();
        });
    }
  }
}
