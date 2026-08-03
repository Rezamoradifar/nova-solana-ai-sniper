/**
 * NO_SELL_ROUTE fix (2026-07-26, Phase 6): before this, a position accumulating
 * consecutive `permanent` (no-route) SELL failures — see
 * sellFailureClassifier.ts — was retried on every single price tick with zero
 * delay, right up until SELL_MAX_PERMANENT_ROUTE_RETRIES was reached and it was
 * marked sellUnsellable. For the default tick interval that means all of a
 * position's permanent-failure budget could burn in well under a minute,
 * hammering Jupiter for a route that was never going to appear that fast.
 *
 * This computes how long PositionManager must wait after the most recent
 * permanent failure before it's allowed to attempt another sell for the same
 * position — doubling each time (1x, 2x, 4x, ... baseMs), capped at maxMs.
 * Pure and side-effect free, same convention as riskTier.ts/pumpProtection.ts:
 * it only computes a duration, it never reads the clock or touches the DB
 * itself (see positionManager.ts's checkAndMaybeClose for the caller that
 * compares this against Date.now() - lastSellFailureAt).
 */
export function computeSellRetryBackoffMs(
  consecutivePermanentFailures: number,
  baseMs: number,
  maxMs: number,
): number {
  if (consecutivePermanentFailures <= 0) return 0;
  const backoffMs = baseMs * 2 ** (consecutivePermanentFailures - 1);
  return Math.min(backoffMs, maxMs);
}
