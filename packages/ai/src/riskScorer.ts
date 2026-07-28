import type { AiProvider } from './provider.js';
import type { AiDecision, AiRiskLevel, AiScore, RiskFlags, TokenInfo } from '@nova/shared';

/**
 * 2026-07-22 audit (multi-LLM consensus calibration): this prompt previously
 * said only "score 0-100, higher = safer," with no shared definition of what
 * any given number means. The two models scored at the time filled that gap
 * with two different internal scales — live data showed they correlate
 * directionally (Pearson r≈0.49 on live samples) but differ by roughly 2x in
 * absolute mean score for the same factual input, with one model
 * specifically penalizing "very young token, still-low holder count/volume"
 * far more heavily — a real judgment difference, not a bug, but one an
 * explicit rubric can at least make consistent instead of each model
 * inventing its own scale. The explicit anchors and the "newness is
 * expected, don't penalize it on its own" clarification below are the fix;
 * no threshold or consensus policy changed alongside this. (2026-07-27:
 * the consensus/voting pipeline itself is now OpenRouter + Ollama only — see
 * consensus.ts — but this prompt's calibration remains provider-agnostic.)
 *
 * 2026-07-28 audit (buy-vote bottleneck): live vote data showed SKIP scores
 * clustering at 65 and BUY scores clustering at 82-85 — the model was reading
 * the old "61-79 = ... not yet confident enough to recommend a buy" wording
 * literally and withholding BUY for the entire middle band, regardless of
 * CONSENSUS_MIN_WEIGHTED_CONFIDENCE (already loosened 85→70 in a prior audit
 * — see consensus.ts). That confidence threshold never mattered because the
 * consensus gate's buyVotes requirement reads this model's own `decision`
 * field, which this prompt alone controls. Reworded the 61-79 band and added
 * an explicit decision instruction below so a clean, no-red-flag token in
 * that range is BUY-eligible instead of structurally excluded.
 */
const SYSTEM_PROMPT = `You are a Solana meme-coin risk analyst embedded in an automated trading system.
You will be given ONLY factual on-chain/market data already collected by the application. Never invent,
assume, or fill in a value that was reported as "unknown" — treat unknown fields as a reason for caution,
not as a safe default.

Score strictly against this rubric — every number you return must correspond to one of these bands, not
your own internal scale:
0-20   = extremely dangerous / very poor opportunity (confirmed or highly likely scam/rug/honeypot
         characteristics present in the supplied data)
21-40  = high risk / weak opportunity (multiple real, factual red flags)
41-60  = uncertain or average (mixed or insufficient signals either way)
61-79  = promising (positive signals outweigh the remaining uncertainty; no material red flags)
80-89  = strong candidate (clear positive signals, no material red flags in the supplied data)
90-100 = exceptional candidate (rare — every available signal is favorable)

This system evaluates tokens at or near launch by design — every token you score is new. Being young, still
building its holder count, or having limited volume so far is expected and must NOT by itself push the score
down; score those factors on what the actual supplied numbers show relative to a token of that age (e.g. an
already-large or already-concentrated holder count for how young the token is IS a real signal worth scoring;
"it hasn't been around long" on its own is not). Judge every other factor — authority/LP status, holder
concentration, liquidity, the honeypot heuristic, recent momentum — strictly on the facts given.

Recommend "decision": "BUY" whenever your score is 61 or higher AND you found no material red flag in the
supplied data — a score anywhere in the 61-100 range is buy-eligible, not just the top of it. Use "decision":
"SKIP" for a score of 60 or below, or for a 61+ score that still carries an unresolved red flag you listed in
"reasons"/"warnings".

Respond with ONLY a JSON object, no markdown fences, no other text, matching exactly this shape:
{"score": <0-100 integer per the rubric above, higher = safer/better opportunity>, "riskLevel": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL", "decision": "BUY"|"SKIP", "reasons": ["<short reason>", ...], "warnings": ["<short warning>", ...]}
"decision" is your recommendation only — the trading system enforces its own deterministic safety
checks independently and a "BUY" here does not guarantee a purchase happens.`;

const VALID_RISK_LEVELS: readonly AiRiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const VALID_DECISIONS: readonly AiDecision[] = ['BUY', 'SKIP'];
const RISK_LEVEL_SEVERITY: Record<AiRiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

interface ParsedAiJson {
  score: number;
  riskLevel: AiRiskLevel;
  decision: AiDecision;
  reasons: string[];
  warnings: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Strictly validates the raw parsed JSON against the required schema. Returns
 * `undefined` (never throws) on ANYTHING that doesn't match exactly — a missing
 * field, wrong type, or an enum value the model invented — so a malformed or
 * partially-correct response can never be coerced into something that looks
 * usable. Callers must treat `undefined` as a hard fail-closed case.
 */
function validateAiJson(parsed: unknown): ParsedAiJson | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;

  const { score } = candidate;
  if (typeof score !== 'number' || !Number.isFinite(score)) return undefined;

  const { riskLevel } = candidate;
  if (typeof riskLevel !== 'string' || !VALID_RISK_LEVELS.includes(riskLevel as AiRiskLevel)) {
    return undefined;
  }

  const { decision } = candidate;
  if (typeof decision !== 'string' || !VALID_DECISIONS.includes(decision as AiDecision)) {
    return undefined;
  }

  const reasons = isStringArray(candidate.reasons) ? candidate.reasons : [];
  const warnings = isStringArray(candidate.warnings) ? candidate.warnings : [];

  return {
    score: Math.max(0, Math.min(100, score)),
    riskLevel: riskLevel as AiRiskLevel,
    decision: decision as AiDecision,
    reasons,
    warnings,
  };
}

/** Fail-closed result shared by every failure path below (provider error, unparseable
 * response, or a response that doesn't match the required schema) — score 0, CRITICAL,
 * SKIP. A config's minAiScore (default 60, always > 0) rejects this via the existing
 * `Math.min(ruleScore, aiScore)` gate in autoTrader.ts, so this alone is enough to keep
 * a failed/invalid AI call from ever being able to trigger a BUY. */
function failClosed(providerName: AiProvider['name'], reason: string, flag: string): AiScore {
  return {
    score: 0,
    riskLevel: 'CRITICAL',
    decision: 'SKIP',
    reasons: [reason],
    warnings: [],
    summary: reason,
    flags: [flag],
    provider: providerName,
  };
}

export async function scoreToken(
  provider: AiProvider,
  token: TokenInfo,
  riskFlags: RiskFlags,
): Promise<AiScore> {
  // Every field below was already computed by RiskAnalyzer for other purposes
  // (liquidity resolution, trade cards, entryFilter.ts) and simply wasn't being
  // shown to the model before — no new data collection, just a fuller prompt.
  const prompt = `Token: ${token.symbol ?? token.mint}
Mint: ${token.mint}
Token age (created at): ${token.createdAt}
DEX (current venue, migrated off pump.fun if not "pumpfun"): ${token.dex}
Mint authority revoked: ${riskFlags.mintAuthorityRevoked}
Freeze authority revoked: ${riskFlags.freezeAuthorityRevoked}
LP burned/locked: ${riskFlags.lpBurnedOrLocked}
Market cap USD: ${riskFlags.marketCapUsd ?? 'unknown'}
Top 10 holder %: ${riskFlags.top10HolderPercent.toFixed(2)}
Holder count (top-20 accounts sampled, not a true total): ${riskFlags.holderCount ?? 'unknown'}
Liquidity USD: ${riskFlags.liquidityUsd} (confidence: ${riskFlags.liquiditySource ?? 'unknown'})
Honeypot/sellability suspected (rule-based): ${riskFlags.isHoneypotSuspected}
Price change 1h/24h: ${riskFlags.priceChangeH1 ?? 'unknown'}% / ${riskFlags.priceChangeH24 ?? 'unknown'}%
Recent buys/sells (shortest window with activity): ${riskFlags.recentBuys ?? 'unknown'} / ${riskFlags.recentSells ?? 'unknown'}
Recent volume USD: ${riskFlags.recentVolumeUsd ?? 'unknown'}`;

  // A provider failure (timeout, rate limit, auth/API error) must fail closed just
  // like an unparseable/invalid response below, never throw uncaught. This was
  // previously unguarded — only JSON.parse had a try/catch — so a provider-level
  // error unwound straight out of scoreToken and aborted the entire calling
  // handleNewTokenLaunch pipeline: no token notification, no auto-buy evaluation,
  // nothing — a launch was silently dropped instead of degrading gracefully. Kept
  // as its own try/catch (distinct from the parse one below) so the flag/summary
  // still tells the two failure modes apart in logs/DB.
  let raw: string;
  try {
    // 2026-07-22 audit (multi-LLM consensus calibration): this is a
    // structured classification task against a fixed rubric, not open-ended
    // generation — neither provider ever had an explicit temperature set
    // here before, so both silently ran at their own 0.7 default, adding
    // unnecessary run-to-run score variance on top of the actual factual
    // signal for what should be a repeatable judgment given the same input.
    // Low but nonzero so the model can still weigh genuinely ambiguous cases
    // rather than degenerating to a single canned answer.
    raw = await provider.generateText(prompt, {
      system: SYSTEM_PROMPT,
      maxTokens: 300,
      temperature: 0.2,
    });
  } catch {
    return failClosed(
      provider.name,
      'AI scoring failed (provider error); treat as high risk until re-checked.',
      'ai_call_error',
    );
  }

  // Defensive only — the system prompt already says not to, but a model can still
  // wrap its answer in a ```json fence despite that instruction. Stripping it here
  // costs nothing on a response that was already bare JSON, and this never invents
  // or repairs *content*, only unwraps formatting around it.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');

  let parsed: ParsedAiJson | undefined;
  try {
    parsed = validateAiJson(JSON.parse(stripped));
  } catch {
    parsed = undefined;
  }
  if (!parsed) {
    return failClosed(
      provider.name,
      'AI response could not be parsed or failed schema validation; treat as high risk until re-checked.',
      'ai_parse_error',
    );
  }

  // Critical Safety Gate, enforced a second time here (defense-in-depth alongside
  // worker.ts's evaluateHardRiskGate, which already skips calling the AI provider
  // at all once one of these is true): no AI decision can ever come back as "BUY"
  // for a token with an unrevoked mint/freeze authority, unlocked LP, or a
  // suspected honeypot, regardless of what the model itself returned.
  const hasCriticalRiskFlag =
    !riskFlags.mintAuthorityRevoked ||
    !riskFlags.freezeAuthorityRevoked ||
    !riskFlags.lpBurnedOrLocked ||
    riskFlags.isHoneypotSuspected;

  let { decision, riskLevel } = parsed;
  let { score } = parsed;
  if (hasCriticalRiskFlag) {
    decision = 'SKIP';
    if (RISK_LEVEL_SEVERITY[riskLevel] < RISK_LEVEL_SEVERITY.HIGH) riskLevel = 'HIGH';
    // Production incident (2026-07-21 audit): decision/riskLevel were forced
    // above, but the numeric score was left untouched — nothing downstream
    // ever reads decision/riskLevel (they're logged only), so an inflated
    // model score for a critical-risk token could still win
    // Math.min(ruleScore, aiScore) in autoTrader.ts's gate. Forced to 0 here
    // too, so the number that actually drives the buy decision can't rescue
    // a token this function has already determined must be skipped.
    // apps/api/src/trading/criticalSecurityGate.ts is the primary, unbypassable
    // enforcement point — this is belt-and-suspenders underneath it.
    score = 0;
  }

  const combinedFlags = [...parsed.reasons, ...parsed.warnings];
  return {
    score,
    riskLevel,
    decision,
    reasons: parsed.reasons,
    warnings: parsed.warnings,
    summary: combinedFlags[0] ?? `${riskLevel} risk, ${decision}`,
    flags: combinedFlags,
    provider: provider.name,
  };
}
