export interface NotifyGateConfig {
  minLiquidityUsd: number;
  minAiScore: number;
}

/** Everything the hard risk gate needs — every field is already produced by
 * RiskAnalyzer.analyze(), no extra RPC/AI call required to evaluate this. */
export interface HardRiskSignals {
  liquidityUsd: number;
  isHoneypotSuspected: boolean;
  freezeAuthorityRevoked: boolean;
  mintAuthorityRevoked: boolean;
  lpBurnedOrLocked: boolean;
}

export interface NotifyGateDecision {
  allowed: boolean;
  /** Empty when allowed. Every failing criterion, not just the first — same
   * convention as entryFilter.ts's EntryDecision, for full-explainability logging. */
  reasons: string[];
}

/**
 * The 5 gates knowable without an AI call — liquidity plus the 4 on-chain
 * risk flags. Split out from evaluateNotifyGate so a caller (handleNewTokenLaunch)
 * can check "is there any point paying for an AI score" *before* spending on
 * one: if a token already fails here, no AI score could change the outcome
 * (see evaluateNotifyGate below), so the AI provider call is skippable.
 */
export function evaluateHardRiskGate(
  signals: HardRiskSignals,
  config: Pick<NotifyGateConfig, 'minLiquidityUsd'>,
): NotifyGateDecision {
  const reasons: string[] = [];

  if (signals.liquidityUsd < config.minLiquidityUsd) reasons.push('liquidity_below_threshold');
  if (signals.isHoneypotSuspected) reasons.push('honeypot_suspected');
  if (!signals.freezeAuthorityRevoked) reasons.push('freeze_authority_enabled');
  if (!signals.mintAuthorityRevoked) reasons.push('mint_risk');
  if (!signals.lpBurnedOrLocked) reasons.push('lp_not_locked');

  return { allowed: reasons.length === 0, reasons };
}

/**
 * Full "is this token worth sending a Telegram notification about" gate —
 * the hard risk gate plus the AI/rule score threshold. Used as the single
 * choke point (worker.ts's notifyAndAutoTrade) both detection sources funnel
 * through, so neither on-chain detection nor the Telegram trend source can
 * notify for a token that fails any of these 6 checks. Does NOT gate
 * auto-buying — AutoTrader already has its own independent, per-user
 * SnipeConfig-based gates for that (liquidity/AI-score/entry-filter/safety),
 * which are unaffected by this.
 */
export function evaluateNotifyGate(
  signals: HardRiskSignals & { aiScore: number },
  config: NotifyGateConfig,
): NotifyGateDecision {
  const hard = evaluateHardRiskGate(signals, config);
  const reasons = [...hard.reasons];
  if (signals.aiScore < config.minAiScore) reasons.push('ai_score_below_threshold');
  return { allowed: reasons.length === 0, reasons };
}
