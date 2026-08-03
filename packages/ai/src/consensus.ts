import type { AiScore } from '@nova/shared';

export type ConsensusDecision = 'BUY' | 'WATCH' | 'SKIP';
export type ConsensusVoter = 'openrouter' | 'ollama';

export interface ConsensusVote {
  provider: ConsensusVoter;
  score: number;
  decision: 'BUY' | 'SKIP';
  /** The weight actually applied when computing weightedConfidence — renormalized
   *  across whichever voters participated (see participated below), so weights
   *  among participants always sum to 1 regardless of how many there are. */
  weight: number;
  /** False when this voter hard-failed (provider error/unparseable response) or
   *  was never configured (Ollama only) — a non-participating vote is still
   *  reported here (for logging) but counts toward neither weightedConfidence
   *  nor buyVotes. */
  participated: boolean;
}

export interface ConsensusResult {
  decision: ConsensusDecision;
  /** Empty only when decision is 'BUY'. */
  reasons: string[];
  openrouter: AiScore;
  /** Present whenever an Ollama score was passed in at all, regardless of whether
   *  it actually participated (see ollamaParticipated) — the raw result is still
   *  worth keeping for logging/observability even on a hard failure. */
  ollama?: AiScore;
  /** True only when OpenRouter's score/decision actually factored into the
   *  decision — false when its call hard-failed. See openrouterParticipated. */
  openrouterParticipated: boolean;
  /** True only when Ollama's score/decision actually factored into the decision —
   *  false when Ollama wasn't configured (no second argument) or its call
   *  hard-failed (see isHardFailure). Either provider being temporarily
   *  unavailable degrades to a single-voter decision on the other rather than
   *  blocking the pipeline — see evaluateMultiLlmConsensus's doc comment. */
  ollamaParticipated: boolean;
  /** Every voter's individual vote, in weight order (openrouter, ollama) —
   *  always length 2 when an ollama AiScore was passed in at all (even on hard
   *  failure, for observability), length 1 otherwise. Callers should log this
   *  in full so "every model's vote" is answerable from the log line alone. */
  votes: ConsensusVote[];
  /** Weighted average of participating voters' scores (0-100) — 0 when both
   *  providers hard-failed and there is no signal left to weight at all. */
  weightedConfidence: number;
  /** How many participating voters recommended BUY (0-2). */
  buyVotes: number;
}

export interface ConsensusThresholds {
  /** The weighted-average score (0-100) required to approve a BUY. */
  minWeightedConfidence: number;
  /** How many of the participating models must independently vote BUY, capped
   *  at however many voters actually participated this round (see
   *  evaluateMultiLlmConsensus's doc comment on single-provider fallback). */
  minBuyVotes: number;
}

export const DEFAULT_CONSENSUS_MIN_WEIGHTED_CONFIDENCE = 85;
export const DEFAULT_CONSENSUS_MIN_BUY_VOTES = 2;
export const DEFAULT_CONSENSUS_THRESHOLDS: ConsensusThresholds = {
  minWeightedConfidence: DEFAULT_CONSENSUS_MIN_WEIGHTED_CONFIDENCE,
  minBuyVotes: DEFAULT_CONSENSUS_MIN_BUY_VOTES,
};

/** Equal per-model weights (2026-07-27 redesign: Gemini removed from the
 * consensus/voting pipeline entirely — see resolveGeminiProvider's doc
 * comment in provider.ts for why its code is kept but no longer called here).
 * RAW weights over both seats, not over however many voters actually
 * participate in a given call — see `renormalizedWeight` below for how a
 * missing/failed voter is handled. */
export const CONSENSUS_WEIGHTS: Record<ConsensusVoter, number> = {
  openrouter: 0.5,
  ollama: 0.5,
};

/** The exact flag values riskScorer.ts's failClosed() sets for a provider error
 * or an unparseable/invalid response — see scoreToken's doc comment. Used here
 * to tell a genuine "the model recommends SKIP" from "the call itself failed",
 * which must never be treated as a mere disagreement (WATCH) or averaged into
 * the weighted confidence as if it were a real (low) score. */
const HARD_FAILURE_FLAGS = new Set(['ai_call_error', 'ai_parse_error']);

function isHardFailure(result: AiScore): boolean {
  return result.flags.some((flag) => HARD_FAILURE_FLAGS.has(flag));
}

/**
 * Weighted multi-LLM consensus gate (2026-07-27 redesign: Gemini removed
 * entirely from scoring/consensus/voting — see the module-level comment on
 * CONSENSUS_WEIGHTS). Pure and independently tested, same convention as
 * criticalSecurityGate.ts/sellabilityCheck.ts — evaluated once per token,
 * unconditionally, before AutoTrader ever runs (see worker.ts's
 * processAiCall). Runs STRICTLY downstream of candidatePipeline.ts's own
 * unconditional deterministic security checks (honeypot/holder-concentration/
 * bundled-wallet/mint-freeze-authority/LP-lock) — this function is never a
 * replacement for those, only ever a second, independent gate a candidate
 * must ALSO clear after already passing them. It also does not weaken
 * riskScorer.ts's own belt-and-suspenders re-check: any individual model
 * whose score reflects a critical risk flag was already force-set to score 0
 * / decision SKIP before it ever reaches here, which drags both the weighted
 * confidence and the BUY-vote count down same as any other SKIP would.
 *
 * Neither OpenRouter nor Ollama is a single point of failure: this must never
 * block the pipeline or delay a BUY just because one provider is temporarily
 * unavailable. When one hard-fails (or Ollama was never configured), the
 * decision degrades to a single-voter vote on whichever one remains —
 * weights renormalize to 100% and minBuyVotes is capped at the number of
 * participants (so a lone remaining voter only has to agree with itself, not
 * satisfy a "both must agree" bar meant for two voters). Only when BOTH
 * providers are unavailable is there no signal left at all, which resolves
 * to a flat SKIP (weightedConfidence 0) rather than a bar with zero
 * participants to clear it.
 *
 * BUY requires ALL of:
 *   1. At least one provider has a usable (non-hard-failed) result.
 *   2. weightedConfidence >= thresholds.minWeightedConfidence (default 85) —
 *      the CONSENSUS_WEIGHTS-weighted average of every PARTICIPATING voter's
 *      score, renormalized so participants' weights sum to 1.
 *   3. At least min(thresholds.minBuyVotes, participant count) of the
 *      participating voters independently recommend BUY.
 */
export function evaluateMultiLlmConsensus(
  openrouter: AiScore,
  ollama?: AiScore,
  thresholds: ConsensusThresholds = DEFAULT_CONSENSUS_THRESHOLDS,
): ConsensusResult {
  const openrouterParticipated = !isHardFailure(openrouter);
  const ollamaParticipated = ollama !== undefined && !isHardFailure(ollama);

  if (!openrouterParticipated && !ollamaParticipated) {
    const reasons: string[] = ['openrouter_failed'];
    if (ollama !== undefined) reasons.push('ollama_failed');
    return {
      decision: 'SKIP',
      reasons,
      openrouter,
      ollama,
      openrouterParticipated: false,
      ollamaParticipated: false,
      votes: [],
      weightedConfidence: 0,
      buyVotes: 0,
    };
  }

  const participants: { provider: ConsensusVoter; result: AiScore }[] = [];
  if (openrouterParticipated) participants.push({ provider: 'openrouter', result: openrouter });
  if (ollamaParticipated) participants.push({ provider: 'ollama', result: ollama! });

  const totalRawWeight = participants.reduce((sum, p) => sum + CONSENSUS_WEIGHTS[p.provider], 0);
  const participatingVotes: ConsensusVote[] = participants.map((p) => ({
    provider: p.provider,
    score: p.result.score,
    decision: p.result.decision,
    weight: CONSENSUS_WEIGHTS[p.provider] / totalRawWeight,
    participated: true,
  }));

  // A non-participating voter, if one was passed in at all, is still reported
  // in `votes` for observability — the caller wants to log every model's
  // vote, including a failed one, not silently drop it.
  const votes: ConsensusVote[] = [...participatingVotes];
  if (!openrouterParticipated) {
    votes.unshift({
      provider: 'openrouter',
      score: openrouter.score,
      decision: openrouter.decision,
      weight: 0,
      participated: false,
    });
  }
  if (ollama && !ollamaParticipated) {
    votes.push({
      provider: 'ollama',
      score: ollama.score,
      decision: ollama.decision,
      weight: 0,
      participated: false,
    });
  }

  const weightedConfidence = participatingVotes.reduce((sum, v) => sum + v.score * v.weight, 0);
  const buyVotes = participatingVotes.filter((v) => v.decision === 'BUY').length;
  // Capped at how many voters actually participated — a lone remaining voter
  // (the other having failed/being unconfigured) only needs to agree with
  // itself, never blocking the pipeline on a bar sized for two voters.
  const effectiveMinBuyVotes = Math.min(thresholds.minBuyVotes, participatingVotes.length);

  const reasons: string[] = [];
  if (buyVotes < effectiveMinBuyVotes) reasons.push('insufficient_buy_votes');
  if (weightedConfidence < thresholds.minWeightedConfidence) {
    reasons.push('weighted_confidence_below_threshold');
  }

  if (reasons.length === 0) {
    return {
      decision: 'BUY',
      reasons: [],
      openrouter,
      ollama,
      openrouterParticipated,
      ollamaParticipated,
      votes,
      weightedConfidence,
      buyVotes,
    };
  }

  // Every participating call completed successfully at this point — a real
  // split in their decisions (not unanimous) is a genuine disagreement
  // (WATCH); unanimous agreement that still misses the bar is a flat SKIP.
  const isDisagreement = new Set(participatingVotes.map((v) => v.decision)).size > 1;
  return {
    decision: isDisagreement ? 'WATCH' : 'SKIP',
    reasons,
    openrouter,
    ollama,
    openrouterParticipated,
    ollamaParticipated,
    votes,
    weightedConfidence,
    buyVotes,
  };
}
