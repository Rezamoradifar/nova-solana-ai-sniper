import type { LiquiditySource } from '../detection/riskAnalyzer.js';

export interface EntryFilterConfig {
  /** Master per-config opt-in — false reproduces today's behavior exactly (always allowed). */
  enabled: boolean;
  minBuySellRatio: number;
  minHolderCount: number;
  minRecentVolumeUsd: number;
  maxTop10HolderPercent: number;
}

export interface EntrySignals {
  liquidityUsd: number;
  liquiditySource: LiquiditySource;
  top10HolderPercent: number;
  holderCount?: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpBurnedOrLocked: boolean;
  isHoneypotSuspected: boolean;
  recentBuys?: number;
  recentSells?: number;
  recentVolumeUsd?: number;
}

export interface EntryDecision {
  allowed: boolean;
  /** Empty when allowed. Every failing criterion, not just the first — useful for logging/analytics. */
  reasons: string[];
}

/** Below this, a pure price-impact estimate (the lowest-confidence liquidity source
 * — see riskAnalyzer.ts's resolveLiquidityUsd) is too unreliable to trust for gating. */
const LOW_CONFIDENCE_LIQUIDITY_FLOOR_USD = 2000;

/**
 * Point-in-time entry gate only — see the plan doc for why trend signals (whale
 * accumulation, momentum reversal, smart-money activity) can't gate a token's
 * *first* buy: there's no "before" to compare against yet. Those live in
 * smartExitEngine.ts instead, once a position exists and is monitored over time.
 *
 * Pure function, same style as exitEngine.ts's evaluateExit — every criterion
 * independently testable, and every failure reason returned (not just the
 * first) so a rejected auto-buy is fully explainable in logs.
 */
export function evaluateEntry(signals: EntrySignals, config: EntryFilterConfig): EntryDecision {
  if (!config.enabled) return { allowed: true, reasons: [] };

  const reasons: string[] = [];

  // Liquidity quality / real liquidity: the liquidity NUMBER itself is already
  // gated elsewhere (SnipeConfig.minLiquidityUsd) — this instead gates the
  // CONFIDENCE of that number, rejecting an unreliable low-liquidity estimate
  // and an outright missing liquidity figure, either of which can otherwise
  // slip past a numeric-only threshold.
  if (signals.liquiditySource === 'unavailable') {
    reasons.push('liquidity_unavailable');
  } else if (
    signals.liquiditySource === 'jupiter_estimate' &&
    signals.liquidityUsd < LOW_CONFIDENCE_LIQUIDITY_FLOOR_USD
  ) {
    reasons.push('liquidity_estimate_too_low_confidence');
  }

  // Mint/authority risk, LP lock/burn (approximate — see riskAnalyzer.ts), honeypot.
  if (!signals.mintAuthorityRevoked) reasons.push('mint_authority_not_revoked');
  if (!signals.freezeAuthorityRevoked) reasons.push('freeze_authority_not_revoked');
  if (!signals.lpBurnedOrLocked) reasons.push('lp_not_locked_or_burned');
  if (signals.isHoneypotSuspected) reasons.push('honeypot_suspected');

  // Holder distribution / wallet concentration.
  if (signals.top10HolderPercent > config.maxTop10HolderPercent) {
    reasons.push('holder_concentration_too_high');
  }
  if (config.minHolderCount > 0 && (signals.holderCount ?? 0) < config.minHolderCount) {
    reasons.push('holder_count_too_low');
  }

  // Buy/sell ratio + volume quality — rejects a pool with real-looking liquidity
  // but manipulated/washed volume (all sells, or no real trading at all).
  const buys = signals.recentBuys ?? 0;
  const sells = signals.recentSells ?? 0;
  if (config.minBuySellRatio > 0 && buys + sells > 0) {
    const ratio = buys / Math.max(sells, 1);
    if (ratio < config.minBuySellRatio) reasons.push('buy_sell_ratio_too_low');
  }
  if (config.minRecentVolumeUsd > 0 && (signals.recentVolumeUsd ?? 0) < config.minRecentVolumeUsd) {
    reasons.push('recent_volume_too_low');
  }

  return { allowed: reasons.length === 0, reasons };
}
