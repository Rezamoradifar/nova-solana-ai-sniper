/** Operator-tuned guards around entries and exits (see the env vars of the same names). */
export interface EntryExitGuards {
  /** Skip a buy whose quote moves the price more than this (percent). 0 disables. */
  maxBuyPriceImpactPercent: number;
  /** Close a position still below timeStopMinProfitPercent after this many minutes. 0 disables. */
  timeStopMinutes: number;
  timeStopMinProfitPercent: number;
}

export const DEFAULT_ENTRY_EXIT_GUARDS: EntryExitGuards = {
  maxBuyPriceImpactPercent: 0,
  timeStopMinutes: 0,
  timeStopMinProfitPercent: 10,
};

/** Jupiter reports priceImpactPct as a fraction string ("0.0123" = 1.23%). */
export function buyPriceImpactTooHigh(
  priceImpactPctFraction: string | undefined,
  maxPercent: number,
): { tooHigh: boolean; impactPercent?: number } {
  if (maxPercent <= 0) return { tooHigh: false };
  const impactPercent = Number(priceImpactPctFraction) * 100;
  if (!Number.isFinite(impactPercent)) return { tooHigh: false };
  return { tooHigh: impactPercent > maxPercent, impactPercent };
}

/**
 * True when a position has been open long enough without reaching the minimum
 * profit, so its capital should be freed. Never fires once a take-profit stage
 * has already triggered (the trailing stop manages the position from there).
 */
export function shouldTimeStop(
  input: {
    openedAt: Date;
    now: Date;
    entryPriceUsd: number;
    currentPriceUsd: number;
    takeProfitStageReached: boolean;
  },
  guards: Pick<EntryExitGuards, 'timeStopMinutes' | 'timeStopMinProfitPercent'>,
): boolean {
  if (guards.timeStopMinutes <= 0 || input.takeProfitStageReached) return false;
  if (input.entryPriceUsd <= 0 || input.currentPriceUsd <= 0) return false;
  const ageMs = input.now.getTime() - input.openedAt.getTime();
  if (ageMs < guards.timeStopMinutes * 60_000) return false;
  const pnlPercent = ((input.currentPriceUsd - input.entryPriceUsd) / input.entryPriceUsd) * 100;
  return pnlPercent < guards.timeStopMinProfitPercent;
}
