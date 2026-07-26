import type { AiScore } from '@nova/shared';

export type ConsensusDecision = 'BUY' | 'WATCH' | 'SKIP';
export type ConsensusVoter = 'gemini' | 'openrouter' | 'ollama';

export interface ConsensusVote {
  provider: ConsensusVoter;
  score: number;
  decision: 'BUY' | 'SKIP';
  /** The weight actually applied when computing weightedConfidence — renormalized
   *  across whichever voters participated (see participated below), so weights
   *  among participants always sum to 1 regardless of how many there are. */
  weight: number;
  /** False when this voter was hard-failed (Gemini/OpenRouter) or unavailable
   *  (Ollama not configured, or its own hard failure) — a non-participating
   *  vote is still reported here (for logging) but counts toward neither
   *  weightedConfidence nor buyVotes. */
  participated: boolean;
}

export interface ConsensusResult {
  decision: ConsensusDecision;
  /** Empty only when decision is 'BUY'. */
  reasons: string[];
  gemini: AiScore;
  openrouter: AiScore;
  /** Present whenever an Ollama score was passed in at all, regardless of whether
   *  it actually participated (see ollamaParticipated) — the raw result is still
   *  worth keeping for logging/observability even on a hard failure. */
  ollama?: AiScore;
  /** True only when Ollama's score/decision actually factored into the decision —
   *  false when Ollama wasn't configured (no third argument) or its call
   *  hard-failed (see isHardFailure). An Ollama outage degrades to a
   *  Gemini+OpenRouter-only vote (reweighted to 100%, both still required to
   *  vote BUY) rather than forcing a SKIP the way a Gemini/OpenRouter failure
   *  does — see evaluateMultiLlmConsensus's doc comment. */
  ollamaParticipated: boolean;
  /** Every voter's individual vote, in weight order (gemini, openrouter,
   *  ollama) — always length 3 when an ollama AiScore was passed in at all
   *  (even on hard failure, for observability), length 2 otherwise. Callers
   *  should log this in full so "every model's vote" is answerable from the
   *  log line alone. */
  votes: ConsensusVote[];
  /** Weighted average of participating voters' scores (0-100) — 0 when a hard
   *  Gemini/OpenRouter failure short-circuited before any weighting happened. */
  weightedConfidence: number;
  /** How many participating voters recommended BUY (0-3). */
  buyVotes: number;
}

export interface ConsensusThresholds {
  /** The weighted-average score (0-100) required to approve a BUY. */
  minWeightedConfidence: number;
  /** How many of the participating models must independently vote BUY. */
  minBuyVotes: number;
}

export const DEFAULT_CONSENSUS_MIN_WEIGHTED_CONFIDENCE = 85;
export const DEFAULT_CONSENSUS_MIN_BUY_VOTES = 2;
export const DEFAULT_CONSENSUS_THRESHOLDS: ConsensusThresholds = {
  minWeightedConfidence: DEFAULT_CONSENSUS_MIN_WEIGHTED_CONFIDENCE,
  minBuyVotes: DEFAULT_CONSENSUS_MIN_BUY_VOTES,
};

/** Fixed per-model weights (2026-07-26 redesign) — Gemini is weighted highest
 * since it's the more reliable/calibrated of the two paid providers (see
 * riskScorer.ts's system-prompt doc comment on the two models' scoring-scale
 * divergence); OpenRouter and Ollama split the remainder evenly. These are
 * RAW weights over all three seats, not over however many voters actually
 * participate in a given call — see `renormalizedWeight` below for how a
 * missing Ollama vote is handled. */
export const CONSENSUS_WEIGHTS: Record<ConsensusVoter, number> = {
  gemini: 0.4,
  openrouter: 0.3,
  ollama: 0.3,
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
 * Weighted multi-LLM consensus gate (2026-07-26 redesign, replacing the prior
 * "Gemini AND OpenRouter both BUY with score >=80" unanimous gate). Pure and
 * independently tested, same convention as criticalSecurityGate.ts/
 * sellabilityCheck.ts — evaluated once per token, unconditionally, before
 * AutoTrader ever runs (see worker.ts's processAiCall). Runs STRICTLY
 * downstream of candidatePipeline.ts's own unconditional deterministic
 * security checks (honeypot/holder-concentration/bundled-wallet/mint-freeze-
 * authority/LP-lock) — this function is never a replacement for those, only
 * ever a second, independent gate a candidate must ALSO clear after already
 * passing them. It also does not weaken riskScorer.ts's own belt-and-
 * suspenders re-check: any individual model whose score reflects a critical
 * risk flag was already force-set to score 0 / decision SKIP before it ever
 * reaches here, which drags both the weighted confidence and the BUY-vote
 * count down same as any other SKIP would.
 *
 * BUY requires ALL of:
 *   1. Neither Gemini nor OpenRouter hard-failed (provider error, timeout, or
 *      an unparseable/invalid response) — checked first, unconditionally; a
 *      hard failure on either always resolves straight to SKIP, exactly as
 *      before, and never gets averaged into the weighted confidence as if it
 *      were a real low score.
 *   2. weightedConfidence >= thresholds.minWeightedConfidence (default 85) —
 *      the CONSENSUS_WEIGHTS-weighted average of every PARTICIPATING voter's
 *      score, renormalized so participants' weights sum to 1 (see
 *      `ollamaParticipated` below).
 *   3. At least thresholds.minBuyVotes (default 2) of the participating
 *      voters independently recommend BUY.
 *
 * Ollama is a best-effort THIRD voter, not a mandatory one: it's a
 * self-hosted model with no uptime guarantee, wired in specifically so an
 * Ollama outage can never be the sole reason a real trade opportunity is
 * missed (unlike Gemini/OpenRouter, whose failures still force SKIP). When
 * `ollama` is omitted, or its call hard-failed, it drops out entirely —
 * Gemini/OpenRouter's weights (40/30) are renormalized to sum to 1 (so,
 * effectively, ~57.1%/42.9%) and minBuyVotes still requires BOTH of the
 * remaining two voters to say BUY (there being only two left to satisfy "at
 * least two"). This is a strictly stricter fallback than simply dropping the
 * requirement to 1 vote would be, while still guaranteeing Ollama's own
 * availability is never a single point of failure for the whole gate.
 */
export function evaluateMultiLlmConsensus(
  gemini: AiScore,
  openrouter: AiScore,
  ollama?: AiScore,
  thresholds: ConsensusThresholds = DEFAULT_CONSENSUS_THRESHOLDS,
): ConsensusResult {
  const geminiFailed = isHardFailure(gemini);
  const openrouterFailed = isHardFailure(openrouter);

  if (geminiFailed || openrouterFailed) {
    const reasons: string[] = [];
    if (geminiFailed) reasons.push('gemini_failed');
    if (openrouterFailed) reasons.push('openrouter_failed');
    return {
      decision: 'SKIP',
      reasons,
      gemini,
      openrouter,
      ollama,
      ollamaParticipated: false,
      votes: [],
      weightedConfidence: 0,
      buyVotes: 0,
    };
  }

  const ollamaParticipated = ollama !== undefined && !isHardFailure(ollama);

  const participants: { provider: ConsensusVoter; result: AiScore }[] = [
    { provider: 'gemini', result: gemini },
    { provider: 'openrouter', result: openrouter },
  ];
  if (ollamaParticipated) participants.push({ provider: 'ollama', result: ollama! });

  const totalRawWeight = participants.reduce((sum, p) => sum + CONSENSUS_WEIGHTS[p.provider], 0);
  const participatingVotes: ConsensusVote[] = participants.map((p) => ({
    provider: p.provider,
    score: p.result.score,
    decision: p.result.decision,
    weight: CONSENSUS_WEIGHTS[p.provider] / totalRawWeight,
    participated: true,
  }));

  // Ollama's own AiScore, if one was passed in at all, is still reported in
  // `votes` even when it didn't participate (hard-failed) — the caller wants
  // to log every model's vote, including a failed one, not silently drop it.
  const votes: ConsensusVote[] =
    ollama && !ollamaParticipated
      ? [
          ...participatingVotes,
          {
            provider: 'ollama',
            score: ollama.score,
            decision: ollama.decision,
            weight: 0,
            participated: false,
          },
        ]
      : participatingVotes;

  const weightedConfidence = participatingVotes.reduce((sum, v) => sum + v.score * v.weight, 0);
  const buyVotes = participatingVotes.filter((v) => v.decision === 'BUY').length;

  const reasons: string[] = [];
  if (buyVotes < thresholds.minBuyVotes) reasons.push('insufficient_buy_votes');
  if (weightedConfidence < thresholds.minWeightedConfidence) {
    reasons.push('weighted_confidence_below_threshold');
  }

  if (reasons.length === 0) {
    return {
      decision: 'BUY',
      reasons: [],
      gemini,
      openrouter,
      ollama,
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
    gemini,
    openrouter,
    ollama,
    ollamaParticipated,
    votes,
    weightedConfidence,
    buyVotes,
  };
}
