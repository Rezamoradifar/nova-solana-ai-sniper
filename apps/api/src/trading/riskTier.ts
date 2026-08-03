/**
 * Dynamic Risk Tiers (2026-07-23, USOH incident follow-up): replaces a fixed
 * token-age ban with a graduated position-size reduction, so the sniper stays
 * able to buy a token seconds after launch (where the real edge is) while
 * shrinking exposure exactly where the incident showed the gate is weakest —
 * a brand-new token whose holder distribution/price action hasn't had time to
 * reveal itself. Tier only ever affects HOW MUCH is bought, never whether the
 * mandatory checks in criticalSecurityGate.ts/sellabilityCheck.ts run — every
 * tier clears the exact same hard gate first.
 *
 * Pure and independently tested, same convention as entryFilter.ts's
 * evaluateEntry / criticalSecurityGate.ts's evaluateCriticalSecurityGate.
 */
export type RiskTier = 'ULTRA_EARLY' | 'EARLY' | 'ESTABLISHED';

export interface RiskTierAgeThresholds {
  ultraEarlyMaxAgeMs: number;
  earlyMaxAgeMs: number;
}

/** Tier A: 0-5min, Tier B: 5-15min, Tier C: 15min+ — the exact bands requested. */
export const DEFAULT_RISK_TIER_AGE_THRESHOLDS: RiskTierAgeThresholds = {
  ultraEarlyMaxAgeMs: 5 * 60 * 1000,
  earlyMaxAgeMs: 15 * 60 * 1000,
};

/**
 * `pairCreatedAtMs` is DexScreener's own pair-creation timestamp (see
 * riskAnalyzer.ts) — the real on-chain age of the token/pool, not "how long
 * ago our detector happened to notice it." Undefined (no DexScreener pair
 * resolved yet) fails closed to age 0 — the strictest tier — same convention
 * as every other unresolved on-chain read in this codebase (see RiskFlags'
 * own doc comments): unknown is never treated as safe/mature.
 */
export function resolveTokenAgeMs(nowMs: number, pairCreatedAtMs: number | undefined): number {
  if (pairCreatedAtMs === undefined) return 0;
  return Math.max(0, nowMs - pairCreatedAtMs);
}

export function classifyRiskTier(tokenAgeMs: number, thresholds: RiskTierAgeThresholds): RiskTier {
  if (tokenAgeMs < thresholds.ultraEarlyMaxAgeMs) return 'ULTRA_EARLY';
  if (tokenAgeMs < thresholds.earlyMaxAgeMs) return 'EARLY';
  return 'ESTABLISHED';
}

/**
 * Extreme-pump protection (do not rely on price increase alone — see
 * pumpProtection.ts): a sudden, extreme price move is itself a fresh risk
 * event independent of how old the token is, so it bumps the effective tier
 * one notch stricter regardless of the age-derived tier. Never escalates past
 * ULTRA_EARLY (already the strictest) and never *de-escalates*.
 */
export function escalateTierForPump(tier: RiskTier): RiskTier {
  if (tier === 'ESTABLISHED') return 'EARLY';
  return 'ULTRA_EARLY';
}

export interface RiskTierSizeConfig {
  /** Basis points (10000 = 100%) of the user's own configured buyAmountSol. */
  ultraEarlySizeBps: number;
  earlySizeBps: number;
  establishedSizeBps: number;
}

/**
 * Defaults chosen so ESTABLISHED reproduces today's exact behavior (100% of
 * configured size — same as before this feature existed) and the earlier
 * tiers scale down from there. Deliberately conservative, not hardcoded
 * absolute SOL amounts — every value here is a multiplier applied to whatever
 * the user already configured (SnipeConfig.buyAmountSol), per the incident
 * follow-up requirement.
 */
export const DEFAULT_RISK_TIER_SIZE_CONFIG: RiskTierSizeConfig = {
  ultraEarlySizeBps: 2500,
  earlySizeBps: 5000,
  establishedSizeBps: 10000,
};

export function resolvePositionSizeMultiplier(tier: RiskTier, config: RiskTierSizeConfig): number {
  const bps =
    tier === 'ULTRA_EARLY'
      ? config.ultraEarlySizeBps
      : tier === 'EARLY'
        ? config.earlySizeBps
        : config.establishedSizeBps;
  return bps / 10_000;
}

/** `buyAmountSol` is always the user's own configured SnipeConfig value — this
 * only ever scales it down (or leaves it unchanged for ESTABLISHED at the
 * default config), never invents a new absolute size. */
export function applyRiskTierSizing(
  buyAmountSol: number,
  tier: RiskTier,
  config: RiskTierSizeConfig,
): number {
  return buyAmountSol * resolvePositionSizeMultiplier(tier, config);
}
