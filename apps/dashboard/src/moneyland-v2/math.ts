/** Pure, read-only interface math. Never produces executable quotes. */
export function indicativeSwapOutput(
  inputAmount: number,
  inputPriceUsd: number | undefined,
  outputPriceUsd: number | undefined,
): number | null {
  if (!Number.isFinite(inputAmount) || inputAmount <= 0 ||
      inputPriceUsd === undefined || !Number.isFinite(inputPriceUsd) || inputPriceUsd <= 0 ||
      outputPriceUsd === undefined || !Number.isFinite(outputPriceUsd) || outputPriceUsd <= 0)
    return null;
  const result = inputAmount * inputPriceUsd / outputPriceUsd;
  return Number.isFinite(result) && result > 0 ? result : null;
}

export interface LoanCostAssumptions {
  principal: number;
  edgePercent: number;
  loanFeePercent: number;
  gasAllowanceUsd: number;
  slippagePercent: number;
}

export interface FlashCostResult {
  grossUsd: number;
  loanFeeUsd: number;
  slippageAllowanceUsd: number;
  gasAllowanceUsd: number;
  netUsd: number;
}

/** Arithmetic stress-model only; not a smart-contract simulation or provider quote. */
export function evaluateFlashCosts(params: LoanCostAssumptions): FlashCostResult | null {
  const { principal, edgePercent, loanFeePercent, gasAllowanceUsd, slippagePercent } = params;
  if (![principal,edgePercent,loanFeePercent,gasAllowanceUsd,slippagePercent].every(Number.isFinite) ||
      principal <= 0 || principal > 1_000_000 ||
      edgePercent < 0 || edgePercent > 30 ||
      loanFeePercent < 0 || loanFeePercent > 10 ||
      gasAllowanceUsd < 0 ||
      slippagePercent < 0 || slippagePercent > 10)
    return null;
  const grossUsd = principal * edgePercent / 100;
  const loanFeeUsd = principal * loanFeePercent / 100;
  const slippageAllowanceUsd = principal * slippagePercent / 100;
  const netUsd = grossUsd - loanFeeUsd - gasAllowanceUsd - slippageAllowanceUsd;
  if (![grossUsd, loanFeeUsd, slippageAllowanceUsd, netUsd].every(Number.isFinite)) return null;
  return { grossUsd, loanFeeUsd, slippageAllowanceUsd, gasAllowanceUsd, netUsd };
}
