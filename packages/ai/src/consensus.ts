import type { AiScore } from '@nova/shared';

export type ConsensusDecision = 'BUY' | 'WATCH' | 'SKIP';

export interface ConsensusResult {
  decision: ConsensusDecision;
  /** Empty only when decision is 'BUY'. */
  reasons: string[];
  gemini: AiScore;
  openrouter: AiScore;
}

export interface ConsensusThresholds {
  /** Both providers' scores must clear this. */
  minAiScore: number;
}

export const DEFAULT_CONSENSUS_MIN_AI_SCORE = 80;

/** The exact flag values riskScorer.ts's failClosed() sets for a provider error
 * or an unparseable/invalid response — see scoreToken's doc comment. Used here
 * to tell a genuine "the model recommends SKIP" from "the call itself failed",
 * which must never be treated as a mere disagreement (WATCH). */
const HARD_FAILURE_FLAGS = new Set(['ai_call_error', 'ai_parse_error']);

function isHardFailure(result: AiScore): boolean {
  return result.flags.some((flag) => HARD_FAILURE_FLAGS.has(flag));
}

/**
 * Multi-LLM consensus gate (2026-07-22): auto-buy requires Gemini AND
 * OpenRouter to independently recommend BUY and both scores >= minAiScore.
 * Pure and independently tested, same convention as
 * criticalSecurityGate.ts/sellabilityCheck.ts — evaluated once per token,
 * unconditionally, before AutoTrader ever runs (see worker.ts's
 * processAiCall). Runs strictly downstream of candidatePipeline.ts's own
 * unconditional deterministic checks, never a replacement for them.
 *
 * 2026-07-22 audit (zero live BUYs traced to root cause): this function
 * originally also gated on `opportunityScore >= minOpportunityScore`,
 * unconditionally for every token. That duplicated — and silently
 * overrode — autoTrader.ts's own Opportunity Score gate (Section 7, part 3),
 * which is deliberately double-opt-in (`opportunityScoreGateGloballyEnabled`
 * AND each SnipeConfig's own `useOpportunityScoreGate`, both required). Live
 * data: 0 of 57 active auto-buy configs have `useOpportunityScoreGate: true`
 * — this gate was blocking every single one of them on a criterion not one
 * of them opted into, before their own per-config settings ever got a chance
 * to run. Opportunity Score enforcement now happens exactly once, in the one
 * place it was already correctly opt-in — this gate no longer touches it at
 * all (the caller still logs the raw score for visibility).
 *
 * A hard failure (provider error, timeout, or invalid/unparseable output) on
 * EITHER side always resolves to SKIP, checked before anything else — a
 * failure that happened to leave the other provider's decision as 'BUY' must
 * never be misread as a genuine disagreement (WATCH) between two real
 * verdicts. Only once both calls actually completed does a real BUY/SKIP
 * split between the two count as a disagreement.
 */
export function evaluateMultiLlmConsensus(
  gemini: AiScore,
  openrouter: AiScore,
  thresholds: ConsensusThresholds = { minAiScore: DEFAULT_CONSENSUS_MIN_AI_SCORE },
): ConsensusResult {
  const geminiFailed = isHardFailure(gemini);
  const openrouterFailed = isHardFailure(openrouter);

  if (geminiFailed || openrouterFailed) {
    const reasons: string[] = [];
    if (geminiFailed) reasons.push('gemini_failed');
    if (openrouterFailed) reasons.push('openrouter_failed');
    return { decision: 'SKIP', reasons, gemini, openrouter };
  }

  const reasons: string[] = [];
  if (gemini.decision !== 'BUY') reasons.push('gemini_decision_not_buy');
  if (openrouter.decision !== 'BUY') reasons.push('openrouter_decision_not_buy');
  if (gemini.score < thresholds.minAiScore) reasons.push('gemini_score_below_threshold');
  if (openrouter.score < thresholds.minAiScore) reasons.push('openrouter_score_below_threshold');

  if (reasons.length === 0) {
    return { decision: 'BUY', reasons: [], gemini, openrouter };
  }

  // Both calls completed successfully at this point (neither hard-failed) —
  // a genuine BUY/SKIP split between them is a real disagreement (WATCH);
  // any other reject (agreement, but a score/threshold miss) is a flat SKIP.
  const isDisagreement = gemini.decision !== openrouter.decision;
  return { decision: isDisagreement ? 'WATCH' : 'SKIP', reasons, gemini, openrouter };
}
