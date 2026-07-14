/**
 * "Never fully sell winners early" — a profit ladder that sells only a slice
 * at each gain tier, always leaving the required moonbag (see
 * INSTITUTIONAL_MIN_MOONBAG_PERCENT) running. Pure, tested like exitEngine.ts;
 * the I/O side (actually executing each partial sell) lives in
 * PositionManager.executePartialSell.
 */
export interface PartialExitTier {
  gainPercent: number;
  sellPercent: number;
}

/** 10% + 15% + 20% sold = 45%, leaving exactly the required 55% moonbag. */
export const DEFAULT_PARTIAL_EXIT_TIERS: readonly PartialExitTier[] = [
  { gainPercent: 100, sellPercent: 10 },
  { gainPercent: 300, sellPercent: 15 },
  { gainPercent: 500, sellPercent: 20 },
];

/** "Always keep at least 55% of the original position as a Moonbag." */
export const INSTITUTIONAL_MIN_MOONBAG_PERCENT = 55;

export interface EvaluatePartialExitInput {
  pnlPercent: number;
  originalAmountToken: number;
  remainingAmountToken: number;
  /** Token-amount floor a partial exit will never sell through — the moonbag. */
  moonbagReserveAmountToken: number;
  tiers: readonly PartialExitTier[];
  /** Zero-based indices into `tiers` already executed for this position. */
  tiersAlreadyTaken: readonly number[];
}

export interface PartialExitDecision {
  tierIndex: number;
  sellAmountToken: number;
}

/**
 * Finds the lowest-indexed untaken tier whose gain threshold the position has
 * reached, and how much to sell for it — clamped so a partial sell never
 * dips into the moonbag reserve, and never sells more than what's actually
 * still held (defensive; shouldn't be reachable given the tiers' own math,
 * but a manually-edited partialTakeProfitTiers config could otherwise oversell).
 */
export function evaluateNextPartialExit(
  input: EvaluatePartialExitInput,
): PartialExitDecision | null {
  for (let i = 0; i < input.tiers.length; i++) {
    if (input.tiersAlreadyTaken.includes(i)) continue;
    const tier = input.tiers[i]!;
    if (input.pnlPercent < tier.gainPercent) continue;

    const rawSellAmount = input.originalAmountToken * (tier.sellPercent / 100);
    const sellableWithoutMoonbag = Math.max(
      0,
      input.remainingAmountToken - input.moonbagReserveAmountToken,
    );
    const sellAmountToken = Math.min(
      rawSellAmount,
      sellableWithoutMoonbag,
      input.remainingAmountToken,
    );
    if (sellAmountToken <= 0) return null;

    return { tierIndex: i, sellAmountToken };
  }
  return null;
}
