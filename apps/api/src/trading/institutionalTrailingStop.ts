/**
 * Institutional Mode's profit-tiered trailing stop — "never cap upside,"
 * so unlike the generic adaptiveTrailingStop.ts (a single distance frozen at
 * open time), this is recomputed fresh every price tick from entryPriceUsd
 * (constant) and the position's already-persisted, monotonic highWaterMarkUsd.
 * Non-institutional positions are completely untouched — they keep using
 * exitEngine.ts's existing frozen-field trailing-stop math unchanged.
 *
 * Monotonicity ("trailing stop may only move upward") falls out of this
 * function being non-decreasing in peakRoiPercent for a fixed entryPriceUsd,
 * combined with highWaterMarkUsd/peakRoiPercent themselves only ever growing
 * (see exitEngine.ts's own Math.max high-water-mark logic) — there's nothing
 * to persist or diff against a previous value.
 */

/** Trailing not active at all before +100% ROI — a fixed stop-loss (see
 * INSTITUTIONAL_STOP_LOSS_PERCENT) is the only downside protection until then. */
const TRAIL_NOT_ACTIVE_BELOW_ROI_PERCENT = 100;
const LOOSE_TRAIL_PERCENT = 35;
const TIGHT_TRAIL_PERCENT_AT_500 = 20;
const TIGHTEN_START_ROI_PERCENT = 300;
const TIGHTEN_END_ROI_PERCENT = 500;
/** "Protect at least 70% of accumulated profit" once ROI passes +500%. */
const MIN_PROFIT_PROTECTION_RATIO_ABOVE_500 = 0.7;

/** Fixed stop-loss for institutional positions before the trailing stop takes
 * over (and disabled entirely once a position is moonbag-only — see
 * partialExitEngine.ts/positionManager.ts's moonbag handling). Institutional
 * mode defines one coherent exit policy, same precedent as the existing
 * trailing-stop presets fully overriding manual TP/SL/trailing values. */
export const INSTITUTIONAL_STOP_LOSS_PERCENT = 35;

function trailPercentForRoi(peakRoiPercent: number): number {
  if (peakRoiPercent < TIGHTEN_START_ROI_PERCENT) return LOOSE_TRAIL_PERCENT;
  if (peakRoiPercent < TIGHTEN_END_ROI_PERCENT) {
    const t =
      (peakRoiPercent - TIGHTEN_START_ROI_PERCENT) /
      (TIGHTEN_END_ROI_PERCENT - TIGHTEN_START_ROI_PERCENT);
    return LOOSE_TRAIL_PERCENT - t * (LOOSE_TRAIL_PERCENT - TIGHT_TRAIL_PERCENT_AT_500);
  }
  return TIGHT_TRAIL_PERCENT_AT_500;
}

/** The ROI floor the tightened trail already implies right at the +500%
 * boundary — used so the literal "at least 70%" floor above +500% is taken
 * as a max() against this, never *loosening* the stop at the handoff point. */
function boundaryFloorRoiPercentAt500(): number {
  const trailPercent = trailPercentForRoi(TIGHTEN_END_ROI_PERCENT);
  const athMultiple = 1 + TIGHTEN_END_ROI_PERCENT / 100;
  const stopMultiple = athMultiple * (1 - trailPercent / 100);
  return (stopMultiple - 1) * 100;
}

export function computeInstitutionalTrailingStopPriceUsd(
  entryPriceUsd: number,
  highWaterMarkUsd: number,
  peakRoiPercent: number,
): number | undefined {
  if (entryPriceUsd <= 0 || peakRoiPercent < TRAIL_NOT_ACTIVE_BELOW_ROI_PERCENT) return undefined;

  if (peakRoiPercent < TIGHTEN_END_ROI_PERCENT) {
    const trailPercent = trailPercentForRoi(peakRoiPercent);
    return highWaterMarkUsd * (1 - trailPercent / 100);
  }

  const literalFloorRoi = MIN_PROFIT_PROTECTION_RATIO_ABOVE_500 * peakRoiPercent;
  const floorRoi = Math.max(literalFloorRoi, boundaryFloorRoiPercentAt500());
  return entryPriceUsd * (1 + floorRoi / 100);
}
