import type { RiskFlags } from '@nova/shared';

/**
 * Production incident (2026-07-21 audit): a token with `isHoneypotSuspected=true`
 * and `top10HolderPercent≈93%` ("Larry") was auto-bought, because every existing
 * check that could have blocked it was either an opt-in per-config filter
 * (entryFilter.ts's evaluateEntry — disabled on all 61 live SnipeConfigs at the
 * time) or a soft point-penalty in RiskAnalyzer.ruleBasedScore that a token can
 * absorb and still clear the default minAiScore threshold. This gate is neither:
 * it runs once per token, unconditionally, before any per-config/per-user
 * evaluation, and a failure here blocks the buy for every config regardless of
 * that config's own settings, its AI score, or its OpportunityScore. Nothing
 * downstream of this function is allowed to override its verdict.
 *
 * 2026-07-22 policy: pump.fun (and any other detection source) must only ever
 * be a discovery signal, never a direct path to a BUY. The DexScreener-source
 * requirement below is what enforces that in practice — see its own comment.
 * The intended order upstream of this gate is: Token Detection -> DexScreener
 * Validation -> fresh on-chain security checks (mint/freeze authority, LP,
 * holder concentration, honeypot heuristic — riskAnalyzer.ts's analyze()) ->
 * this gate -> sellabilityCheck.ts's real sell-route + price-impact simulation
 * -> AI analysis -> Opportunity Score -> BUY or SKIP. AI score and Opportunity
 * Score are evaluated downstream of both this gate and the sellability check
 * and can never override either — see autoTrader.ts's evaluateAndMaybeBuy.
 */

/** Calibrated against real incident data (2026-07-21 audit): blocks Larry (93%),
 * a blank-symbol ORCA token (96%, 1 holder), and "Zca" (99.96%, 2 holders) while
 * not blocking real, legitimately concentrated-but-established tokens observed
 * in production (MOODENG 54%, buidl 58.6%, LUCE 51.4%). */
export const HARD_MAX_TOP10_HOLDER_PERCENT = 90;

/** The two confirmed-bad tokens above had holderCount 1 and 2; every legitimate
 * token observed in production had 19+. Sits well clear of both. */
export const HARD_MIN_HOLDER_COUNT = 5;

export interface CriticalSecurityGateResult {
  allowed: boolean;
  /** Empty when allowed. Every failing criterion, not just the first. */
  reasons: string[];
}

/**
 * Pure so it's independently unit-tested — same convention as
 * exitEngine.ts's evaluateExit and entryFilter.ts's evaluateEntry. Every
 * input here already fails closed at its own source (see riskAnalyzer.ts's
 * onchain.ts calls: an RPC failure resolves mintAuthorityRevoked/
 * freezeAuthorityRevoked to `false` and holder concentration to 100%/0 count,
 * never to "assume safe") — this function only has to check the resulting
 * values, not guard against them being missing.
 *
 * 2026-07-22 audit (false-positive rejections): unknown data still blocks a
 * buy exactly as before (see riskFlags.*DataUnknown's own doc comment in
 * @nova/shared) — the only change is which reason string gets pushed, so
 * logs/alerts can tell "we couldn't verify this" from "we verified it's
 * bad." A caller that only checks `allowed` sees identical behavior either
 * way.
 */
export function evaluateCriticalSecurityGate(riskFlags: RiskFlags): CriticalSecurityGateResult {
  const reasons: string[] = [];

  if (!riskFlags.mintAuthorityRevoked) {
    reasons.push(
      riskFlags.mintAuthorityDataUnknown ? 'mint_authority_unknown' : 'mint_authority_not_revoked',
    );
  }
  if (!riskFlags.freezeAuthorityRevoked) {
    reasons.push(
      riskFlags.mintAuthorityDataUnknown
        ? 'freeze_authority_unknown'
        : 'freeze_authority_not_revoked',
    );
  }
  if (!riskFlags.lpBurnedOrLocked) reasons.push('lp_not_locked_or_burned');
  if (riskFlags.isHoneypotSuspected) {
    reasons.push(riskFlags.honeypotCheckUnknown ? 'honeypot_check_unknown' : 'honeypot_suspected');
  }
  // DexScreener Validation (2026-07-22 policy): a pre-migration pump.fun bonding-curve
  // token has no DexScreener listing at all, so resolveLiquidity's own fallback chain
  // (native DEX read -> bonding-curve estimate -> Jupiter price-impact estimate) is what
  // let pump.fun launches reach a BUY on self-reported/estimated numbers alone — exactly
  // the "pump.fun directly triggers a buy" gap this closes. Requiring the source to be
  // exactly 'dexscreener' (not just "some source resolved") means a token can only be
  // bought once an independent, aggregated market actually lists it — pump.fun itself is
  // discovery-only from here on. This subsumes the old unavailable-only check: every
  // non-dexscreener source (including 'unavailable') now fails the same way.
  if (riskFlags.liquiditySource !== 'dexscreener') {
    reasons.push('dexscreener_validation_failed');
  }
  const holderConcentrationCritical = riskFlags.top10HolderPercent >= HARD_MAX_TOP10_HOLDER_PERCENT;
  const holderCountCritical = (riskFlags.holderCount ?? 0) < HARD_MIN_HOLDER_COUNT;
  if (holderConcentrationCritical || holderCountCritical) {
    if (riskFlags.holderDataUnknown) {
      reasons.push('holder_data_unknown');
    } else {
      if (holderConcentrationCritical) reasons.push('holder_concentration_critical');
      if (holderCountCritical) reasons.push('holder_count_critical');
    }
  }

  // Bundled-wallet / holder-clustering (2026-07-23 USOH incident follow-up):
  // holderClustering.ts's analyzeHolderClustering runs in riskAnalyzer.ts
  // alongside the aggregate top10/count checks above, but looks at the SHAPE
  // of the distribution (near-identical balances across many wallets) rather
  // than just its aggregate concentration — exactly the signal that let the
  // incident token clear both checks above while 18 of its top 20 holders
  // held an almost identical ~0.25% each. Confirmed UNSAFE always blocks,
  // same as every other criterion in this gate; UNKNOWN (holder data itself
  // never resolved — see holderDataUnknown, which already blocks separately)
  // is deliberately NOT re-flagged here to avoid duplicating that reason.
  if (riskFlags.holderClusteringState === 'UNSAFE') {
    reasons.push(...(riskFlags.holderClusteringReasons ?? ['bundled_wallet_cluster_detected']));
  }

  return { allowed: reasons.length === 0, reasons };
}

export type SecurityCheckState = 'SAFE' | 'UNSAFE' | 'UNKNOWN';

export interface SecurityStateBreakdown {
  mintAuthority: SecurityCheckState;
  freezeAuthority: SecurityCheckState;
  lpLock: SecurityCheckState;
  honeypot: SecurityCheckState;
  dexscreenerValidation: SecurityCheckState;
  holderConcentration: SecurityCheckState;
  holderCount: SecurityCheckState;
  holderClustering: SecurityCheckState;
}

/**
 * Per-criterion SAFE/UNSAFE/UNKNOWN breakdown for structured logging only —
 * evaluateCriticalSecurityGate above is the sole source of truth for the
 * actual allow/block decision (both UNSAFE and UNKNOWN block equally there).
 * This exists so an operator reading a rejection log can immediately tell
 * "confirmed bad" apart from "couldn't verify" per criterion, instead of
 * only seeing the combined reason string.
 */
export function classifySecurityState(riskFlags: RiskFlags): SecurityStateBreakdown {
  const authorityUnknown = !!riskFlags.mintAuthorityDataUnknown;
  const holderUnknown = !!riskFlags.holderDataUnknown;
  const honeypotUnknown = !!riskFlags.honeypotCheckUnknown;

  return {
    mintAuthority: authorityUnknown
      ? 'UNKNOWN'
      : riskFlags.mintAuthorityRevoked
        ? 'SAFE'
        : 'UNSAFE',
    freezeAuthority: authorityUnknown
      ? 'UNKNOWN'
      : riskFlags.freezeAuthorityRevoked
        ? 'SAFE'
        : 'UNSAFE',
    lpLock: riskFlags.lpBurnedOrLocked ? 'SAFE' : 'UNSAFE',
    honeypot: honeypotUnknown ? 'UNKNOWN' : riskFlags.isHoneypotSuspected ? 'UNSAFE' : 'SAFE',
    dexscreenerValidation: riskFlags.liquiditySource === 'dexscreener' ? 'SAFE' : 'UNSAFE',
    holderConcentration: holderUnknown
      ? 'UNKNOWN'
      : riskFlags.top10HolderPercent >= HARD_MAX_TOP10_HOLDER_PERCENT
        ? 'UNSAFE'
        : 'SAFE',
    holderCount: holderUnknown
      ? 'UNKNOWN'
      : (riskFlags.holderCount ?? 0) < HARD_MIN_HOLDER_COUNT
        ? 'UNSAFE'
        : 'SAFE',
    holderClustering: riskFlags.holderClusteringState ?? 'UNKNOWN',
  };
}
