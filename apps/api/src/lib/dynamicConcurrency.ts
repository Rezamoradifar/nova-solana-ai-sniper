/**
 * Massive Scanner Scalability (Phase 2, 2026-07-26): discoveryQueue's
 * concurrency (see priorityQueue.ts) used to be a fixed number from env
 * config — always DISCOVERY_QUEUE_CONCURRENCY, whether the RPC layer had
 * spare headroom and the queue was falling behind, or the primary RPC
 * provider was already under rate-limit pressure. This computes a new
 * target concurrency from live signals (see
 * detection/scannerConcurrencyGovernor.ts, the only caller) so the queue can
 * safely use RPC headroom when it exists and pull back the moment it
 * doesn't, without a human retuning the env var by hand after the fact.
 *
 * Deliberately conservative and step-wise — never jumps straight to a bound:
 * scaling up is additive (+stepUp) so a burst can't itself trigger the next
 * burst's rate-limiting; scaling down under real pressure is multiplicative
 * (halved) so the queue backs off fast, standard AIMD congestion-control
 * behavior. Pure and side-effect free, same convention as
 * riskTier.ts/sellRetryBackoff.ts/pumpProtection.ts — the caller owns
 * reading the live signals and applying the result.
 */
export interface ConcurrencyGovernorInputs {
  /** Items waiting for a worker slot right now (queue.pending()). */
  pending: number;
  /** Items actively being processed right now (queue.active()). */
  active: number;
  currentConcurrency: number;
  minConcurrency: number;
  maxConcurrency: number;
  /**
   * True only when the primary (first-preferred) RPC provider is currently
   * in a rate-limit cooldown — see resilientConnection.ts's
   * rpcCooldownRegistry and connection.ts's tier doc comment. A non-primary
   * (fallback-tier) provider cooling down is expected, routine noise (e.g.
   * QuickNode's documented daily-cap behavior) and must NEVER be passed here
   * — treating it as pressure would throttle the whole scanner down for a
   * problem that isn't actually hurting throughput.
   */
  primaryRpcUnderPressure: boolean;
  /** Node event-loop-delay p95, in ms — see perfMonitor.ts. */
  eventLoopLagMs: number;
  /** Above this, the single Node process is falling behind regardless of
   * queue/RPC state — see ecosystem.config.cjs: everything in this codebase
   * (HTTP server + every scanner/monitor loop) runs in one `fork`-mode
   * process, so event-loop lag is the most direct "this process is
   * struggling" signal available without adding a profiler dependency. */
  eventLoopLagCeilingMs: number;
  /** Additive step when scaling up. Defaults to 2. */
  stepUp?: number;
}

export type ConcurrencyAdjustmentReason =
  'rpc_pressure' | 'event_loop_lag' | 'backlog' | 'idle' | 'unchanged';

export interface ConcurrencyDecision {
  concurrency: number;
  reason: ConcurrencyAdjustmentReason;
}

const DEFAULT_STEP_UP = 2;

export function computeNextConcurrency(inputs: ConcurrencyGovernorInputs): ConcurrencyDecision {
  const {
    pending,
    active,
    currentConcurrency,
    minConcurrency,
    maxConcurrency,
    primaryRpcUnderPressure,
    eventLoopLagMs,
    eventLoopLagCeilingMs,
    stepUp = DEFAULT_STEP_UP,
  } = inputs;

  const clamp = (n: number) => Math.min(maxConcurrency, Math.max(minConcurrency, n));

  // Backpressure signals win outright, ahead of any backlog-driven scale-up —
  // a queue that's both backlogged AND causing RPC pressure must still back
  // off; retrying faster is exactly what got it into that state.
  if (primaryRpcUnderPressure) {
    return { concurrency: clamp(Math.floor(currentConcurrency / 2)), reason: 'rpc_pressure' };
  }
  if (eventLoopLagMs > eventLoopLagCeilingMs) {
    return { concurrency: clamp(Math.floor(currentConcurrency / 2)), reason: 'event_loop_lag' };
  }
  // More waiting than currently running means the queue is falling behind
  // its own concurrency limit — safe to grow, since neither backpressure
  // signal above fired.
  if (pending > active) {
    return { concurrency: clamp(currentConcurrency + stepUp), reason: 'backlog' };
  }
  // Nothing waiting and most of today's capacity sits idle — release it back
  // toward the floor. Cheap (idle capacity costs nothing at rest) but keeps
  // concurrency from sitting at a stale high-water mark indefinitely, so a
  // later burst starts its ramp-up gradually instead of immediately opening
  // a large number of parallel RPC calls at once.
  if (pending === 0 && active <= Math.max(1, Math.floor(currentConcurrency / 2))) {
    return { concurrency: clamp(currentConcurrency - 1), reason: 'idle' };
  }
  return { concurrency: clamp(currentConcurrency), reason: 'unchanged' };
}
