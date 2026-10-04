/**
 * Stop-loss on what the position is actually worth right now: a Jupiter quote
 * for selling the remaining tokens, compared with what they cost. Unlike a
 * DexScreener price it can't lag or be an outlier, and it already includes
 * slippage and pool depth - so a crash is acted on at once instead of waiting
 * for the price feed to catch up.
 */
export function evaluateRealValueStop(input: {
  investedSol: number;
  originalAmountToken: number;
  remainingAmountToken: number;
  exitValueSol: number;
  stopLossPercent: number | null;
  takeProfitStageReached: boolean;
}): { breached: boolean; pnlPercent: number } {
  const { investedSol, originalAmountToken, remainingAmountToken, exitValueSol } = input;
  if (investedSol <= 0 || originalAmountToken <= 0 || remainingAmountToken <= 0) {
    return { breached: false, pnlPercent: 0 };
  }
  // Cost basis of just the tokens still held (after any partial take-profit).
  const costSol = investedSol * (remainingAmountToken / originalAmountToken);
  const pnlPercent = ((exitValueSol - costSol) / costSol) * 100;
  // Once the take-profit stage has triggered, the trailing stop owns the exit.
  if (input.stopLossPercent == null || input.takeProfitStageReached) {
    return { breached: false, pnlPercent };
  }
  return {
    breached: exitValueSol <= costSol * (1 - Math.abs(input.stopLossPercent) / 100),
    pnlPercent,
  };
}
