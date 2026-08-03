import type { PrismaClient, ShadowDecision } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { EarlyMomentumMetrics } from './earlyMomentumDetector.js';

/**
 * Shadow-mode logging (Sections 3-4, 2026-07-22). `decideShadowVerdict` is
 * pure — same shape as packages/ai/src/consensus.ts's
 * evaluateMultiLlmConsensus — but its output is ONLY EVER LOGGED via
 * recordShadowDecision below, never fed to AutoTrader/autoTrader.ts. Nothing
 * in this file can gate or execute a real trade.
 */

export interface ShadowVerdictComponents {
  safetyScore: number;
  aiScore?: number;
  smartMoneyScore?: number;
  earlyMomentumScore?: number;
  opportunityScore: number;
}

export interface ShadowVerdictThresholds {
  minAiScore: number;
  minOpportunityScore: number;
}

export const DEFAULT_SHADOW_MIN_AI_SCORE = 70;
export const DEFAULT_SHADOW_MIN_OPPORTUNITY_SCORE = 70;

/**
 * Purely advisory hypothetical verdict for shadow-mode evaluation. BUY
 * requires a real AI score at or above the threshold AND the composite
 * Opportunity Score at or above its own threshold; missing components (no AI
 * provider configured, or the wallet/momentum engines disabled) simply can't
 * contribute a reason to buy — a missing aiScore always resolves to SKIP, not
 * an assumed pass, since "we don't know" must never look like "it's good."
 */
export function decideShadowVerdict(
  components: ShadowVerdictComponents,
  thresholds: ShadowVerdictThresholds = {
    minAiScore: DEFAULT_SHADOW_MIN_AI_SCORE,
    minOpportunityScore: DEFAULT_SHADOW_MIN_OPPORTUNITY_SCORE,
  },
): { decision: ShadowDecision; reasons: string[] } {
  const reasons: string[] = [];

  if (components.aiScore === undefined) {
    reasons.push('ai_score_unavailable');
  } else if (components.aiScore < thresholds.minAiScore) {
    reasons.push('ai_score_below_threshold');
  }
  if (components.opportunityScore < thresholds.minOpportunityScore) {
    reasons.push('opportunity_score_below_threshold');
  }

  if (reasons.length === 0) {
    return { decision: 'BUY', reasons: [] };
  }

  // A near-miss (AI score present and not too far under the bar, opportunity
  // score present) reads as WATCH rather than a flat SKIP — mirrors
  // consensus.ts's BUY/WATCH/SKIP three-way split for the same reason: a
  // borderline candidate is worth surfacing differently than an outright
  // reject.
  const nearMiss =
    components.aiScore !== undefined &&
    components.aiScore >= thresholds.minAiScore - 10 &&
    components.opportunityScore >= thresholds.minOpportunityScore - 10;

  return { decision: nearMiss ? 'WATCH' : 'SKIP', reasons };
}

export interface RecordShadowDecisionInput {
  tokenId: string;
  mint: string;
  safetyScore: number;
  aiScore?: number;
  smartMoneyScore?: number;
  earlyMomentumScore?: number;
  opportunityScore: number;
  smartMoneyClusterBuy: boolean;
  clusterWalletCount?: number;
  sybilDiscountApplied: boolean;
  momentumBreakdown?: EarlyMomentumMetrics;
  priceAtDetectionUsd?: number;
}

export interface ShadowModeEvaluatorDeps {
  prisma: PrismaClient;
  logger: Logger;
}

/**
 * Writes exactly one ShadowModeDecisionLog row. Called unconditionally for
 * every token that reaches worker.ts's processAiCall (i.e. every token that
 * already passed the critical security gate), independent of whether
 * SMART_MONEY_ANALYSIS_ENABLED/EARLY_MOMENTUM_DETECTION_ENABLED are on
 * (those score fields are simply null when off). Never throws into the
 * caller — a logging failure is logged and swallowed, never allowed to
 * affect the real pipeline it's observing.
 */
export async function recordShadowDecision(
  deps: ShadowModeEvaluatorDeps,
  input: RecordShadowDecisionInput,
): Promise<void> {
  try {
    const verdict = decideShadowVerdict({
      safetyScore: input.safetyScore,
      aiScore: input.aiScore,
      smartMoneyScore: input.smartMoneyScore,
      earlyMomentumScore: input.earlyMomentumScore,
      opportunityScore: input.opportunityScore,
    });
    await deps.prisma.shadowModeDecisionLog.create({
      data: {
        tokenId: input.tokenId,
        mint: input.mint,
        safetyScore: input.safetyScore,
        aiScore: input.aiScore,
        smartMoneyScore: input.smartMoneyScore,
        earlyMomentumScore: input.earlyMomentumScore,
        opportunityScore: input.opportunityScore,
        smartMoneyClusterBuy: input.smartMoneyClusterBuy,
        clusterWalletCount: input.clusterWalletCount,
        sybilDiscountApplied: input.sybilDiscountApplied,
        momentumBreakdown: input.momentumBreakdown
          ? JSON.parse(JSON.stringify(input.momentumBreakdown))
          : undefined,
        hypotheticalDecision: verdict.decision,
        reasons: verdict.reasons,
        priceAtDetectionUsd: input.priceAtDetectionUsd,
      },
    });
  } catch (err) {
    deps.logger.warn(
      { mint: input.mint, err },
      'shadowModeEvaluator: recordShadowDecision failed — non-fatal',
    );
  }
}
