export interface ExitCheckInput {
  entryPriceUsd: number;
  currentPriceUsd: number;
  highWaterMarkUsd: number;
  takeProfitPercent?: number | null;
  stopLossPercent?: number | null;
  trailingStopPercent?: number | null;
}

export type ExitReason = 'take_profit' | 'stop_loss' | 'trailing_stop';

export interface ExitDecision {
  shouldExit: boolean;
  reason?: ExitReason;
  newHighWaterMarkUsd: number;
  pnlPercent: number;
}

/**
 * A single price-feed read more than this multiple away from the last known
 * reference price is treated as a bad tick, not a real move — rejected before
 * it can corrupt highWaterMarkUsd (which is monotonic and never self-corrects)
 * or fire a bogus take-profit/trailing-stop off a phantom price. Live-verified
 * 2026-07-11: a single DexScreener read for a mint recorded ~5000x its real
 * trading price and got persisted as that position's all-time-high with
 * nothing to catch it, since PriceMonitor had no plausibility check at all.
 * 20x is deliberately generous — real memecoin moves of that scale do happen,
 * but essentially never within one ~15s poll tick; a true multi-day 20x is
 * always the sum of many smaller tick-to-tick deltas, none of which would
 * individually trip this.
 */
export const MAX_PRICE_TICK_MULTIPLIER = 20;

/**
 * Pure so it's independently unit-tested and so PriceMonitor can check a raw
 * price read before ever handing it to evaluateExit/persisting it as a new
 * high-water mark. referencePriceUsd should be the position's current
 * highWaterMarkUsd (falling back to entryPriceUsd) — the highest-confidence
 * "last known real price" already on file.
 */
export function isPlausiblePriceUpdate(
  referencePriceUsd: number,
  candidatePriceUsd: number,
  maxMultiplier: number = MAX_PRICE_TICK_MULTIPLIER,
): boolean {
  if (!Number.isFinite(candidatePriceUsd) || candidatePriceUsd <= 0) return false;
  if (referencePriceUsd <= 0) return true; // nothing to compare against yet — can't reject
  const ratio = candidatePriceUsd / referencePriceUsd;
  return ratio <= maxMultiplier && ratio >= 1 / maxMultiplier;
}

/**
 * Pure function so TP/SL/trailing-stop logic can be exhaustively unit tested
 * without touching the DB or an RPC connection. Called on every price tick.
 */
export function evaluateExit(input: ExitCheckInput): ExitDecision {
  // A zero/negative entry price means it's genuinely unknown (never divide by it — that
  // produces Infinity/NaN, which trivially "beats" any take-profit/stop-loss threshold
  // and fires an exit that has nothing to do with real price movement). Treat it as 0%
  // PnL instead: neither TP nor SL can fire off a made-up number, while trailing-stop
  // (which only compares currentPriceUsd against its own high-water mark, not entry)
  // is unaffected and keeps working.
  const pnlPercent =
    input.entryPriceUsd > 0
      ? ((input.currentPriceUsd - input.entryPriceUsd) / input.entryPriceUsd) * 100
      : 0;

  const newHighWaterMarkUsd = Math.max(input.highWaterMarkUsd, input.currentPriceUsd);

  if (input.takeProfitPercent != null && pnlPercent >= input.takeProfitPercent) {
    return { shouldExit: true, reason: 'take_profit', newHighWaterMarkUsd, pnlPercent };
  }

  if (input.stopLossPercent != null && pnlPercent <= -Math.abs(input.stopLossPercent)) {
    return { shouldExit: true, reason: 'stop_loss', newHighWaterMarkUsd, pnlPercent };
  }

  if (input.trailingStopPercent != null) {
    const dropFromHighPercent =
      ((newHighWaterMarkUsd - input.currentPriceUsd) / newHighWaterMarkUsd) * 100;
    if (dropFromHighPercent >= input.trailingStopPercent) {
      return { shouldExit: true, reason: 'trailing_stop', newHighWaterMarkUsd, pnlPercent };
    }
  }

  return { shouldExit: false, newHighWaterMarkUsd, pnlPercent };
}
