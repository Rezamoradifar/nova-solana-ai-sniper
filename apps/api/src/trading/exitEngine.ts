export interface ExitCheckInput {
  entryPriceUsd: number;
  currentPriceUsd: number;
  highWaterMarkUsd: number;
  takeProfitPercent?: number | null;
  stopLossPercent?: number | null;
  trailingStopPercent?: number | null;
}

export type ExitReason = 'take_profit' | 'stop_loss' | 'trailing_stop';

export type PriceReconciliationSource =
  'jupiter_reverse_quote' | 'native_dex_reserves' | 'forced_after_ceiling';

export interface PriceReconciliationResult {
  accepted: boolean;
  source?: PriceReconciliationSource;
}

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
 * Root-cause fix (2026-07-18) for "price tick rejected as implausible
 * outlier — skipping this position this tick" leaving an OPEN position
 * starved of price updates forever: isPlausiblePriceUpdate above is correct
 * and stays exactly as-is (it exists because of a real incident — see its
 * own doc comment — and loosening/removing it would reintroduce that bug).
 * But it had no escape hatch: if a position's true price ever moves >20x
 * from a stale/corrupted reference, every future tick gets rejected
 * indefinitely with nothing to recover it. PriceMonitor now tracks
 * consecutive rejections per position and, once that streak is long enough
 * (or has lasted long enough) to no longer look like a single bad read,
 * calls this function to check whether a second, independently-sourced
 * price read corroborates the rejected candidate before accepting it.
 */
export const OUTLIER_RECONCILE_AFTER_CONSECUTIVE_REJECTIONS = 3;
export const OUTLIER_FORCE_ACCEPT_AFTER_MS = 10 * 60 * 1000;

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
 * Decides whether a candidate price that already failed isPlausiblePriceUpdate
 * should now be accepted, given zero or more independently-sourced same-tick
 * price reads (a reverse Jupiter quote, a native DEX pool's reserve ratio).
 * "Corroborates" means the independent source agrees with the candidate
 * within corroborationToleranceMultiplier — deliberately tighter than the 20x
 * rejection band, since two differently-sourced reads agreeing within 3x is
 * strong evidence the move is real rather than one bad read. forcedAfterCeiling
 * lets the caller accept the candidate anyway once a hard time ceiling has
 * elapsed with no corroboration available — the one path that can "fix" a
 * corrupted reference without corroboration, reserved for PriceMonitor to
 * invoke only after OUTLIER_FORCE_ACCEPT_AFTER_MS of sustained rejection, so a
 * genuine sustained crash is never misclassified as bad data forever.
 */
export function reconcilePriceOutlier(params: {
  candidatePriceUsd: number;
  jupiterReverseQuotePriceUsd?: number;
  nativeDexReservesPriceUsd?: number;
  forcedAfterCeiling?: boolean;
  corroborationToleranceMultiplier?: number;
}): PriceReconciliationResult {
  const tolerance = params.corroborationToleranceMultiplier ?? 3;
  const agrees = (otherPriceUsd: number | undefined): boolean => {
    if (otherPriceUsd === undefined || !Number.isFinite(otherPriceUsd) || otherPriceUsd <= 0) {
      return false;
    }
    const ratio = params.candidatePriceUsd / otherPriceUsd;
    return ratio <= tolerance && ratio >= 1 / tolerance;
  };

  if (agrees(params.jupiterReverseQuotePriceUsd)) {
    return { accepted: true, source: 'jupiter_reverse_quote' };
  }
  if (agrees(params.nativeDexReservesPriceUsd)) {
    return { accepted: true, source: 'native_dex_reserves' };
  }
  if (params.forcedAfterCeiling) {
    return { accepted: true, source: 'forced_after_ceiling' };
  }
  return { accepted: false };
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
