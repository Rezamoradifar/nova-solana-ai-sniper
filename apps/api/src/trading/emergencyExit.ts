/**
 * Emergency Exit Engine — pure decision logic. The system-wide safety net
 * (2026-07-28: watches every OPEN position, not just Institutional Mode
 * ones — see emergencyExitMonitor.ts's own doc comment): unlike a
 * profit-tiered trailing stop, which only reacts to price, this reacts to
 * on-chain/liquidity signals that price alone can lag behind or miss
 * entirely (a rug can drain liquidity before DexScreener's price feed even
 * updates). Checked on its own slower interval by emergencyExitMonitor.ts —
 * see EMERGENCY_EXIT_CHECK_INTERVAL_MS's doc comment in
 * packages/shared/src/env.ts for why it's not on every price tick. Every
 * trigger sells 100% of whatever remains (including an institutional-mode
 * moonbag, where "the moonbag may never exit on a normal pullback" — see
 * positionManager.ts — explicitly carves out an exception for this engine).
 *
 * Pure and independently unit-tested, same convention as evaluateExit
 * (exitEngine.ts) and evaluateNextPartialExit (partialExitEngine.ts) — the
 * monitor that calls this only gathers signals and executes the resulting
 * decision, it never encodes trigger logic itself.
 */

export type EmergencyExitReason =
  | 'liquidity_removed'
  | 'trading_disabled'
  | 'mint_reenabled'
  | 'freeze_reenabled'
  | 'critical_rug_score'
  | 'dev_wallet_dump';

/** Matches RiskAnalyzer's own honeypot liquidity floor (riskAnalyzer.ts:
 * `isHoneypotSuspected` already treats <$500 liquidity as suspect) — reusing
 * it here keeps "liquidity is effectively gone" consistent across the
 * codebase rather than inventing a second, different number. */
export const LIQUIDITY_REMOVED_THRESHOLD_USD = 500;

/** Institutional Mode's entry bar requires a combined score >=85
 * (autoTrader.ts's INSTITUTIONAL_MIN_AI_SCORE) — a post-entry collapse to
 * below 30 is not "got a bit worse," it's a fundamentally different token
 * than the one that was bought. */
export const CRITICAL_RUG_SCORE_THRESHOLD = 30;

/** "Major" dumping — half or more of what the tracked wallet held at entry
 * is gone. Deliberately not a smaller number: normal early trading activity
 * (a partial take-profit by a large early holder) shouldn't itself read as
 * a rug signal — only a genuinely large, one-sided liquidation should. */
export const DEV_WALLET_DUMP_THRESHOLD_PERCENT = 50;

export interface EmergencyExitSignals {
  liquidityUsd: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  /** Result of a live Jupiter sell-route probe (token -> SOL) this exact
   * tick — false means no route was found, i.e. the position cannot
   * currently be sold via Jupiter at all ("trading disabled"). */
  canSell: boolean;
  /** RiskAnalyzer.ruleBasedScore(...) computed from this same tick's fresh
   * (bypassCache: true) analyze() result. */
  ruleScore: number;
  /** Raw balance of the tracked top-holder proxy wallet (see onchain.ts's
   * getTopHolder) at position-open time. Undefined if it couldn't be
   * resolved at open — the dev-wallet-dump check is skipped, not treated as
   * a trigger, when either this or devWalletCurrentAmountRaw is undefined. */
  devWalletAmountRawAtEntry?: bigint;
  /** That same address's raw balance as of this tick. */
  devWalletCurrentAmountRaw?: bigint;
}

export interface EmergencyExitDecision {
  shouldExit: boolean;
  reason?: EmergencyExitReason;
  /** Human-readable diagnostic — e.g. "liquidityUsd=120 < 500" — for the
   * EmergencyExitLog audit row and the Telegram alert. Undefined when
   * shouldExit is false. */
  detail?: string;
}

/**
 * Checked in the same priority order as the requirements this engine was
 * built against — the first matching condition wins and short-circuits the
 * rest (once 100% is being sold anyway, which specific reason fires first
 * doesn't change the outcome, only the recorded diagnostic).
 */
export function evaluateEmergencyExit(signals: EmergencyExitSignals): EmergencyExitDecision {
  if (signals.liquidityUsd < LIQUIDITY_REMOVED_THRESHOLD_USD) {
    return {
      shouldExit: true,
      reason: 'liquidity_removed',
      detail: `liquidityUsd=${signals.liquidityUsd} < ${LIQUIDITY_REMOVED_THRESHOLD_USD}`,
    };
  }

  if (!signals.canSell) {
    return {
      shouldExit: true,
      reason: 'trading_disabled',
      detail: 'Jupiter sell-route probe (token -> SOL) found no route',
    };
  }

  if (!signals.mintAuthorityRevoked) {
    return {
      shouldExit: true,
      reason: 'mint_reenabled',
      detail: 'mint authority is present (re-enabled since entry, or entry check was stale)',
    };
  }

  if (!signals.freezeAuthorityRevoked) {
    return {
      shouldExit: true,
      reason: 'freeze_reenabled',
      detail: 'freeze authority is present (re-enabled since entry, or entry check was stale)',
    };
  }

  if (signals.ruleScore < CRITICAL_RUG_SCORE_THRESHOLD) {
    return {
      shouldExit: true,
      reason: 'critical_rug_score',
      detail: `ruleScore=${signals.ruleScore} < ${CRITICAL_RUG_SCORE_THRESHOLD}`,
    };
  }

  if (
    signals.devWalletAmountRawAtEntry !== undefined &&
    signals.devWalletCurrentAmountRaw !== undefined &&
    signals.devWalletAmountRawAtEntry > 0n
  ) {
    const soldRaw = signals.devWalletAmountRawAtEntry - signals.devWalletCurrentAmountRaw;
    const soldPercent =
      soldRaw > 0n ? (Number(soldRaw) / Number(signals.devWalletAmountRawAtEntry)) * 100 : 0;
    if (soldPercent >= DEV_WALLET_DUMP_THRESHOLD_PERCENT) {
      return {
        shouldExit: true,
        reason: 'dev_wallet_dump',
        detail: `tracked top-holder balance dropped ${soldPercent.toFixed(1)}% since entry (>= ${DEV_WALLET_DUMP_THRESHOLD_PERCENT}%)`,
      };
    }
  }

  return { shouldExit: false };
}
