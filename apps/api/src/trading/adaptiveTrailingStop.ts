/**
 * Optional exit-strategy layer, additive on top of the existing, untouched
 * evaluateExit (exitEngine.ts). This module only decides what numbers to feed
 * into that function before a position opens — it does not change how TP/SL/
 * trailing-stop are evaluated on each price tick. A position that doesn't opt
 * into a preset (trailingStopPreset null/'custom') behaves exactly as before:
 * the user's own manually-set takeProfitPercent/stopLossPercent/
 * trailingStopPercent are used unchanged.
 *
 * "AI Adaptive Distance" is deliberately narrower than the full list of signals
 * a truly institutional system might use (volatility, whale activity, momentum,
 * trend strength, DEX activity, a calibrated AI-confidence score) — none of
 * those are computed anywhere in this codebase today, and inventing them for a
 * live-money exit decision without a real backtest would be irresponsible. This
 * only adjusts distance using the two real, already-computed risk signals that
 * exist at the moment a position opens: liquidityUsd and top10HolderPercent
 * (both from RiskAnalyzer). The preset's own base distance still dominates.
 */

import type { TrailingStopPreset } from '@nova/shared';
export type { TrailingStopPreset };
export { TRAILING_STOP_PRESETS } from '@nova/shared';

/** Base trailing-stop distance (percent below the running all-time-high) per preset. */
const BASE_TRAILING_PERCENT: Record<Exclude<TrailingStopPreset, 'custom'>, number> = {
  conservative: 8,
  balanced: 15,
  aggressive: 25,
  meme_coin: 30,
};

/**
 * Stop-loss floor per preset — this protects the *initial* entry before the
 * trailing stop has anything to lock (price hasn't made a new high yet). Once
 * the trailing stop is above this level, evaluateExit's own ordering (TP, then
 * SL, then trailing) means the trailing stop takes over as the effective floor.
 */
const BASE_STOP_LOSS_PERCENT: Record<Exclude<TrailingStopPreset, 'custom'>, number> = {
  conservative: 15,
  balanced: 25,
  aggressive: 35,
  meme_coin: 40,
};

const MIN_TRAILING_PERCENT = 3;
const MAX_TRAILING_PERCENT = 50;

export interface AdaptiveDistanceInput {
  liquidityUsd: number;
  top10HolderPercent: number;
}

/**
 * Widens the trail for deep-liquidity, low-concentration tokens (price moves
 * more like a real market, less erratically off a single wallet's trade — some
 * extra room avoids getting stopped out by ordinary noise), tightens it for
 * thin-liquidity or highly-concentrated tokens (more single-wallet dump/rug
 * risk — lock gains sooner). Deltas are intentionally small relative to each
 * preset's base distance, so the preset's own character always dominates.
 */
export function computeAdaptiveTrailingStopPercent(
  preset: Exclude<TrailingStopPreset, 'custom'>,
  input: AdaptiveDistanceInput,
): number {
  const base = BASE_TRAILING_PERCENT[preset];

  const liquidityAdjust = input.liquidityUsd >= 100_000 ? 3 : input.liquidityUsd >= 20_000 ? 0 : -3;
  const concentrationAdjust =
    input.top10HolderPercent >= 50 ? -3 : input.top10HolderPercent >= 30 ? 0 : 2;

  const adjusted = base + liquidityAdjust + concentrationAdjust;
  return Math.min(MAX_TRAILING_PERCENT, Math.max(MIN_TRAILING_PERCENT, adjusted));
}

export function stopLossPercentForPreset(preset: Exclude<TrailingStopPreset, 'custom'>): number {
  return BASE_STOP_LOSS_PERCENT[preset];
}

export interface PresetExitParams {
  takeProfitPercent: undefined;
  stopLossPercent: number;
  trailingStopPercent: number;
}

/**
 * The actual TP/SL/trailing values to hand to PositionManager.openPosition for a
 * preset-driven position — takeProfitPercent is always undefined (no profit cap,
 * per requirement #1), matching evaluateExit's existing null-means-"no TP" contract.
 */
export function resolvePresetExitParams(
  preset: Exclude<TrailingStopPreset, 'custom'>,
  input: AdaptiveDistanceInput,
): PresetExitParams {
  return {
    takeProfitPercent: undefined,
    stopLossPercent: stopLossPercentForPreset(preset),
    trailingStopPercent: computeAdaptiveTrailingStopPercent(preset, input),
  };
}

export interface TrailingStopDisplay {
  entryPriceUsd: number;
  currentPriceUsd: number;
  athUsd: number;
  currentProfitPercent: number;
  currentProfitUsd: number;
  highestProfitPercent: number;
  trailingStopPriceUsd: number | undefined;
  lockedProfitPercent: number | undefined;
  distanceToStopPercent: number | undefined;
}

/**
 * Every field here is derived from data the system already has (entry price,
 * running ATH/high-water-mark, trailing %, live price, invested SOL) — no new
 * detection, just presenting what evaluateExit already computes/tracks. Mirrors
 * evaluateExit's own trailing-stop price formula (highWaterMark * (1 - pct/100))
 * exactly, so the displayed "Current Trailing Stop" always matches what would
 * actually fire the exit.
 */
export function computeTrailingStopDisplay(params: {
  entryPriceUsd: number;
  currentPriceUsd: number;
  highWaterMarkUsd: number;
  amountToken: number;
  tokenDecimals: number;
  trailingStopPercent?: number | null;
}): TrailingStopDisplay {
  const { entryPriceUsd, currentPriceUsd, amountToken, tokenDecimals, trailingStopPercent } =
    params;
  const athUsd = Math.max(params.highWaterMarkUsd, currentPriceUsd);

  const currentProfitPercent =
    entryPriceUsd > 0 ? ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100 : 0;
  const realTokenCount = amountToken / 10 ** tokenDecimals;
  const currentProfitUsd = (currentPriceUsd - entryPriceUsd) * realTokenCount;
  const highestProfitPercent =
    entryPriceUsd > 0 ? ((athUsd - entryPriceUsd) / entryPriceUsd) * 100 : 0;

  let trailingStopPriceUsd: number | undefined;
  let lockedProfitPercent: number | undefined;
  let distanceToStopPercent: number | undefined;
  if (trailingStopPercent != null) {
    trailingStopPriceUsd = athUsd * (1 - trailingStopPercent / 100);
    lockedProfitPercent =
      entryPriceUsd > 0 ? ((trailingStopPriceUsd - entryPriceUsd) / entryPriceUsd) * 100 : 0;
    distanceToStopPercent =
      currentPriceUsd > 0 ? ((currentPriceUsd - trailingStopPriceUsd) / currentPriceUsd) * 100 : 0;
  }

  return {
    entryPriceUsd,
    currentPriceUsd,
    athUsd,
    currentProfitPercent,
    currentProfitUsd,
    highestProfitPercent,
    trailingStopPriceUsd,
    lockedProfitPercent,
    distanceToStopPercent,
  };
}
