import { evaluateExit, type EvaluateExitReason } from './exitEngine.js';

/**
 * TP1 / Breakeven / Trailing exit strategy (2026-07-28) — a new, minimal,
 * dedicated exit strategy, deliberately NOT built on top of the existing
 * Institutional Mode partial-exit-ladder/moonbag/ROI-tiered-trailing system
 * (partialExitEngine.ts, institutionalTrailingStop.ts). That system is fully
 * built but has never run against real money and solves a different problem
 * (an N-tier ladder with a permanent moonbag reserve and upside that's never
 * capped) — this strategy is exactly the simpler, explicit spec: take 50% at
 * +50% ROI, move the stop-loss to breakeven, then trail the remaining 50% at
 * a volatility-adaptive distance around a 15% base until it exits.
 *
 * Every decision here is made by calling evaluateExit (exitEngine.ts) with a
 * different set of TP/SL/trailing values depending on lifecycle state — this
 * module never reimplements that arithmetic. This is also what lets the
 * backtest engine (apps/api/src/trading/backtestMetrics.ts /
 * apps/api/scripts/runStrategyBacktest.ts) replay the exact same decision
 * logic that runs live, by calling this same function — live behavior and
 * backtested behavior can never drift apart.
 */

/**
 * The global, operator-tunable knobs for this strategy (packages/shared/src/
 * env.ts's EXIT_V2_* vars) — distinct from Tp1TrailingInput's per-call fields
 * (entryPriceUsd/currentPriceUsd/highWaterMarkUsd/volatilityStdDevPercent/
 * state), which vary per position per tick. Bundled as one object (rather
 * than more positional constructor params on PositionManager) since every
 * caller needs the same 8 values together — the live wiring (worker.ts) and
 * the backtest replay (runStrategyBacktest.ts) both construct one of these
 * from the same env defaults.
 */
export interface Tp1TrailingConfig {
  initialStopLossPercent: number;
  breakevenStopLossPercent: number;
  tp1RoiPercent: number;
  tp1SellFraction: number;
  baseTrailingPercent: number;
  trailingMinPercent: number;
  trailingMaxPercent: number;
  volatilityReferenceStdDevPercent: number;
}

/** Matches every EXIT_V2_* default in packages/shared/src/env.ts exactly —
 * kept in sync manually since this module has no dependency on @nova/shared's
 * zod schema (pure, DB- and env-free by design). */
export const DEFAULT_TP1_TRAILING_CONFIG: Tp1TrailingConfig = {
  initialStopLossPercent: 20,
  breakevenStopLossPercent: 2,
  tp1RoiPercent: 50,
  tp1SellFraction: 0.5,
  baseTrailingPercent: 15,
  trailingMinPercent: 10,
  trailingMaxPercent: 25,
  volatilityReferenceStdDevPercent: 5,
};

export interface Tp1TrailingState {
  /** Non-null once TP1 has fired — mirrors Position.trailingActivatedAt.
   * Pre-TP1 (null): evaluateExit is called with a TP1 target and the
   * position's initial stop-loss, no trailing. Post-TP1 (non-null):
   * evaluateExit is called with no TP cap, the breakeven stop-loss, and the
   * volatility-adaptive trailing distance. */
  trailingActivatedAt: number | null;
}

export interface Tp1TrailingInput {
  entryPriceUsd: number;
  currentPriceUsd: number;
  highWaterMarkUsd: number;
  /** Frozen at open, already clamped through exitEngine.ts's
   * resolveEffectiveStopLossPercent/DEFAULT_MAX_LOSS_PERCENT ceiling — this
   * module does not re-clamp it. */
  initialStopLossPercent: number;
  /** 0-5, "move stop loss to breakeven (+0% to +5%)" per spec. */
  breakevenStopLossPercent: number;
  /** ROI% that triggers TP1 — default 50. */
  tp1RoiPercent: number;
  /** Fraction (0-1) of the position sold at TP1 — default 0.5 ("sell exactly
   * 50%"). */
  tp1SellFraction: number;
  /** Base trailing distance before volatility adjustment — default 15. */
  baseTrailingPercent: number;
  /** Rolling stddev of recent percent-returns (see priceVolatilityTracker.ts)
   * — undefined when there aren't yet enough samples to compute one, in
   * which case the trailing distance falls back to baseTrailingPercent
   * unadjusted (ratio treated as 1). */
  volatilityStdDevPercent?: number;
  trailingMinPercent: number;
  trailingMaxPercent: number;
  /** Calibration constant: the "normal" volatility level baseTrailingPercent
   * is calibrated for. An unvalidated constant (default 5) — see this
   * module's own README-style note in computeVolatilityAdaptiveTrailingPercent
   * and re-examine it against the backtest (runStrategyBacktest.ts) before
   * any live rollout. */
  volatilityReferenceStdDevPercent: number;
  state: Tp1TrailingState;
}

export type Tp1TrailingAction =
  | { type: 'none'; newHighWaterMarkUsd: number }
  | {
      type: 'tp1_partial_exit';
      sellFraction: number;
      newHighWaterMarkUsd: number;
      pnlPercent: number;
    }
  | {
      type: 'close';
      reason: Extract<EvaluateExitReason, 'stop_loss' | 'trailing_stop'>;
      newHighWaterMarkUsd: number;
      pnlPercent: number;
    };

/**
 * Ratio-based volatility adaptation: higher realized volatility widens the
 * trail (avoids noise stop-outs on a genuinely choppy token); lower
 * volatility tightens it (locks in gains sooner on a calmer one). The
 * reference stddev is a deliberately simple, unvalidated calibration
 * constant — this formula has no external validation yet beyond "does the
 * math behave sanely at the clamp boundaries" (see this file's own test
 * suite); Phase 7's backtest is what actually checks whether this constant
 * (and the min/max clamp band) are well-chosen before any live use.
 */
export function computeVolatilityAdaptiveTrailingPercent(params: {
  baseTrailingPercent: number;
  volatilityStdDevPercent?: number;
  volatilityReferenceStdDevPercent: number;
  trailingMinPercent: number;
  trailingMaxPercent: number;
}): number {
  const ratio =
    params.volatilityStdDevPercent === undefined
      ? 1
      : clamp(params.volatilityStdDevPercent / params.volatilityReferenceStdDevPercent, 0.5, 2.0);
  return clamp(
    params.baseTrailingPercent * ratio,
    params.trailingMinPercent,
    params.trailingMaxPercent,
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function evaluateTp1TrailingStrategy(input: Tp1TrailingInput): Tp1TrailingAction {
  const preTp1 = input.state.trailingActivatedAt == null;

  if (preTp1) {
    const decision = evaluateExit({
      entryPriceUsd: input.entryPriceUsd,
      currentPriceUsd: input.currentPriceUsd,
      highWaterMarkUsd: input.highWaterMarkUsd,
      takeProfitPercent: input.tp1RoiPercent,
      stopLossPercent: input.initialStopLossPercent,
      trailingStopPercent: undefined,
    });

    if (!decision.shouldExit) {
      return { type: 'none', newHighWaterMarkUsd: decision.newHighWaterMarkUsd };
    }
    if (decision.reason === 'stop_loss') {
      return {
        type: 'close',
        reason: 'stop_loss',
        newHighWaterMarkUsd: decision.newHighWaterMarkUsd,
        pnlPercent: decision.pnlPercent,
      };
    }
    // 'take_profit' -> TP1 fires: sell the configured fraction (default
    // 50%), the position stays open for the trailing phase.
    return {
      type: 'tp1_partial_exit',
      sellFraction: input.tp1SellFraction,
      newHighWaterMarkUsd: decision.newHighWaterMarkUsd,
      pnlPercent: decision.pnlPercent,
    };
  }

  const adaptiveTrailingPercent = computeVolatilityAdaptiveTrailingPercent({
    baseTrailingPercent: input.baseTrailingPercent,
    volatilityStdDevPercent: input.volatilityStdDevPercent,
    volatilityReferenceStdDevPercent: input.volatilityReferenceStdDevPercent,
    trailingMinPercent: input.trailingMinPercent,
    trailingMaxPercent: input.trailingMaxPercent,
  });

  const decision = evaluateExit({
    entryPriceUsd: input.entryPriceUsd,
    currentPriceUsd: input.currentPriceUsd,
    highWaterMarkUsd: input.highWaterMarkUsd,
    takeProfitPercent: undefined, // never cap upside once trailing
    stopLossPercent: input.breakevenStopLossPercent,
    trailingStopPercent: adaptiveTrailingPercent,
  });

  if (!decision.shouldExit) {
    return { type: 'none', newHighWaterMarkUsd: decision.newHighWaterMarkUsd };
  }
  // Post-TP1, evaluateExit can only return 'stop_loss' (breakeven) or
  // 'trailing_stop' — takeProfitPercent is undefined so 'take_profit' can't
  // fire.
  return {
    type: 'close',
    reason: decision.reason as 'stop_loss' | 'trailing_stop',
    newHighWaterMarkUsd: decision.newHighWaterMarkUsd,
    pnlPercent: decision.pnlPercent,
  };
}
