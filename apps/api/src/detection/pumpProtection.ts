/**
 * Extreme-pump protection (2026-07-23, USOH incident follow-up): the incident
 * token was up +372,983% in the hours between launch and detection of the
 * problem — but a brand-new pump.fun/PumpSwap launch can legitimately move
 * thousands of percent in its first minutes purely from real, organic early
 * trading, so price appreciation alone is deliberately NOT used to classify a
 * token as a scam (that would reject good early snipes, exactly the
 * capability this whole feature is meant to preserve). This only flags the
 * *signal* — actual manipulation-or-not is decided by combining this with
 * holderClustering.ts's finding, in criticalSecurityGate.ts/autoTrader.ts.
 *
 * Pure and independently tested, same convention as riskTier.ts.
 */
export interface PumpProtectionConfig {
  /** priceChangeH1 (DexScreener, already on RiskFlags — see riskAnalyzer.ts)
   * at or above this % is treated as an extreme, fresh price-manipulation
   * risk event, independent of the token's age-derived risk tier. */
  extremePumpH1ThresholdPercent: number;
}

export const DEFAULT_PUMP_PROTECTION_CONFIG: PumpProtectionConfig = {
  extremePumpH1ThresholdPercent: 500,
};

export function isExtremePump(
  priceChangeH1: number | undefined,
  config: PumpProtectionConfig,
): boolean {
  return priceChangeH1 !== undefined && priceChangeH1 >= config.extremePumpH1ThresholdPercent;
}
