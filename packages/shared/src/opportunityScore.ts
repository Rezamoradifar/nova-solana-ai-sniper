/**
 * Final Opportunity Score (Section 7) — a transparent, weighted composite of
 * up to 5 components. Pure, no DB/RPC access, same convention as fee.ts.
 *
 * Only Safety and AI are real today (see RiskAnalyzer.ruleBasedScore and
 * packages/ai's scoreToken); Momentum/Wallet/Social don't have engines yet
 * (Sections 3-5) and are represented as undefined, not 0 — a missing
 * component should never be as bad as a token that was actually evaluated
 * and scored terribly.
 */

export interface OpportunityScoreComponents {
  /** Always present — RiskAnalyzer.ruleBasedScore runs on every token. */
  safetyScore: number;
  /** undefined until Section 3 (Momentum Engine) exists. */
  momentumScore?: number;
  /** undefined until Section 4 (Wallet Intelligence) exists. */
  walletScore?: number;
  /** undefined until Section 5 (Social/Trend Signals) exists. */
  socialScore?: number;
  /** undefined when no AI provider is configured. */
  aiScore?: number;
}

export interface OpportunityScoreWeights {
  safetyWeightBps: number;
  momentumWeightBps: number;
  walletWeightBps: number;
  socialWeightBps: number;
  aiWeightBps: number;
}

export interface OpportunityScoreResult {
  finalScore: number;
  breakdown: OpportunityScoreComponents;
  /** The weights snapshot actually applied this evaluation — for the log. */
  weightsUsed: OpportunityScoreWeights;
}

/**
 * A missing component (undefined) is excluded from BOTH the numerator and
 * the weight-sum denominator — the weighted average renormalizes over only
 * the components actually available this evaluation, rather than treating
 * "unknown" as zero (which would unfairly punish a token) or as
 * absent-but-still-diluting-the-average (which would silently change the
 * score's scale as engines are added later). safetyScore is always present.
 *
 * Returns finalScore 0 in the degenerate case where every available
 * component has 0 weight (nothing to average).
 */
export function calculateOpportunityScore(
  components: OpportunityScoreComponents,
  weights: OpportunityScoreWeights,
): OpportunityScoreResult {
  const pairs: Array<[number | undefined, number]> = [
    [components.safetyScore, weights.safetyWeightBps],
    [components.momentumScore, weights.momentumWeightBps],
    [components.walletScore, weights.walletWeightBps],
    [components.socialScore, weights.socialWeightBps],
    [components.aiScore, weights.aiWeightBps],
  ];

  let weightedSum = 0;
  let weightTotal = 0;
  for (const [score, weightBps] of pairs) {
    if (score === undefined) continue;
    weightedSum += score * weightBps;
    weightTotal += weightBps;
  }

  const finalScore = weightTotal > 0 ? weightedSum / weightTotal : 0;

  return {
    finalScore,
    breakdown: { ...components },
    weightsUsed: { ...weights },
  };
}
