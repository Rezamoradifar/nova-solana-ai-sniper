import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { RiskFlags } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';
import { RiskAnalyzer } from '../detection/riskAnalyzer.js';
import { TtlCache } from '../lib/ttlCache.js';
import type { PositionManager } from './positionManager.js';
import { SafetyCheckError } from './safety.js';
import { SellabilityCheckError } from './sellabilityCheck.js';
import { evaluateEntry } from './entryFilter.js';
import {
  resolvePresetExitParams,
  TRAILING_STOP_PRESETS,
  type TrailingStopPreset,
} from './adaptiveTrailingStop.js';
import { DEFAULT_TP1_TRAILING_CONFIG, type Tp1TrailingConfig } from './tp1TrailingStrategy.js';
import {
  applyRiskTierSizing,
  classifyRiskTier,
  DEFAULT_RISK_TIER_AGE_THRESHOLDS,
  DEFAULT_RISK_TIER_SIZE_CONFIG,
  escalateTierForPump,
  type RiskTierAgeThresholds,
  type RiskTierSizeConfig,
} from './riskTier.js';

/**
 * "Once per user" for the low-balance warning, cheaply — a fixed TTL, not a
 * state-based "cleared the moment they actually deposit" flag (that would
 * need a DB-backed field so it survives a restart; this in-memory cache
 * doesn't, same accepted trade-off as ui/pending.ts). 24h means a user who
 * never tops up gets re-notified once a day rather than on every single
 * skipped launch — plausibly dozens of times an hour otherwise, per the
 * 2026-07-18 pipeline health check (223 wallet-balance blocks in ~4h for 20
 * users, all before this cache existed).
 */
const LOW_BALANCE_NOTIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** Narrows the raw DB string (or null/'custom') to a preset the adaptive formula understands. */
function activePreset(raw: string | null): Exclude<TrailingStopPreset, 'custom'> | undefined {
  return raw && (TRAILING_STOP_PRESETS as readonly string[]).includes(raw)
    ? (raw as Exclude<TrailingStopPreset, 'custom'>)
    : undefined;
}

/**
 * Root-cause investigation 2026-07-12: an accepted token (passed the notify
 * gate — liquidity OK, risk checks passed, AI score visible) can still be
 * silently rejected by a per-config gate here, and every one of these
 * rejections was previously logged at `debug` level only — invisible in
 * production (LOG_LEVEL=info). This guarantees a single, always-visible,
 * greppable line with the exact reason and source location for every
 * cancelled buy, so "accepted but no buy" is never unexplained again.
 */
function logBuyCancelled(
  logger: Logger,
  fields: {
    mint: string;
    userId: string;
    reason: string;
    location: string;
    [key: string]: unknown;
  },
): void {
  const { reason, ...rest } = fields;
  logger.warn(rest, `BUY CANCELLED\nReason:\n${reason}`);
}

export interface EvaluateLaunchInput {
  mint: string;
  liquidityUsd: number;
  aiScore: number;
}

export interface AutoTraderDeps {
  prisma: PrismaClient;
  riskAnalyzer: RiskAnalyzer;
  positionManager: PositionManager;
  logger: Logger;
  encryptionKey: string;
  /** Master switch (ENTRY_FILTER_ENABLED) — a config's own entryFilterEnabled
   * still must ALSO be true; both must opt in. Defaults to false (unchanged
   * behavior) so existing deployments need an explicit env change to activate. */
  entryFilterGloballyEnabled?: boolean;
  /** Master switch (OPPORTUNITY_SCORE_GATE_ENABLED) — a config's own
   * useOpportunityScoreGate still must ALSO be true; both must opt in.
   * Defaults to false, reproducing today's exact Math.min(ruleScore, aiScore)
   * gate for every existing config. */
  opportunityScoreGateGloballyEnabled?: boolean;
  /** Optional so every existing/test caller that omits it is unaffected — the
   * low-balance warning below is a no-op without it, same convention as every
   * other notifier?.notifyX(...) call site in this codebase. */
  notifier?: NotificationService;
  /** Dynamic Risk Tiers (2026-07-23 USOH incident follow-up) — see
   * riskTier.ts. Unlike entryFilterGloballyEnabled/
   * opportunityScoreGateGloballyEnabled, this is not a feature flag: it's
   * always active (defaults applied when omitted) since it's a direct safety
   * response to a live incident, not an opt-in experiment. Every value here
   * is a multiplier/threshold, never a hardcoded absolute SOL amount — see
   * riskTier.ts's own doc comments. */
  riskTierAgeThresholds?: RiskTierAgeThresholds;
  riskTierSizeConfig?: RiskTierSizeConfig;
  /** TP1 / Breakeven / Trailing exit strategy (2026-07-28/29) — double
   * opt-in, same convention as entryFilterGloballyEnabled above: a config's
   * own exitStrategy must ALSO be 'tp1_trailing_v1'. Defaults false/
   * DEFAULT_TP1_TRAILING_CONFIG so every existing caller/test that omits
   * these gets exactly today's preset/manual exitParams behavior. */
  exitStrategyV2GloballyEnabled?: boolean;
  exitV2Config?: Tp1TrailingConfig;
}

/**
 * Evaluates a freshly-detected token launch against every active auto-buy
 * SnipeConfig and fires an open-position call for each one that passes its
 * own thresholds. Configs are per-user, so one loose config doesn't cause
 * every user's wallet to buy.
 */
export class AutoTrader {
  private readonly lowBalanceNotifiedCache = new TtlCache<string>(LOW_BALANCE_NOTIFY_TTL_MS);

  constructor(private readonly deps: AutoTraderDeps) {}

  async evaluateAndMaybeBuy(
    mint: string,
    tokenId: string,
    riskFlags: RiskFlags,
    aiScore: number,
    /**
     * Latency Optimization Stage 1 (2026-07-14): epoch-ms timestamps captured
     * upstream in worker.ts, before this function's own per-user filter loop
     * even runs — token detection and AI scoring happen once per token, not
     * once per user, so they're passed in rather than re-measured here.
     * Optional so every existing/test caller that omits it is unaffected.
     */
    pipelineTimestamps?: {
      tokenDetectedAt?: number;
      aiScoringStartAt?: number;
      aiScoringEndAt?: number;
      /**
       * Two-stage discovery pipeline (2026-07-22): epoch-ms timestamps from
       * candidatePipeline.ts's runCandidatePipeline (which now runs the
       * critical-security-gate + sellability checks that used to live here,
       * once per token, before this function is even called) plus
       * `decisionAt`, captured just upstream of this call once the
       * Opportunity Score is computed. All optional, same convention as the
       * three fields above.
       */
      analysisStartedAt?: number;
      dexValidatedAt?: number;
      safetyCompletedAt?: number;
      sellabilityVerifiedAt?: number;
      decisionAt?: number;
    },
    /**
     * Final Opportunity Score (Section 7, 2026-07-18): the weighted composite
     * computed once per token upstream in worker.ts (persisted to
     * OpportunityScoreLog regardless of what happens here). Optional so every
     * existing/test caller that omits it is unaffected; only used below when a
     * config has opted into useOpportunityScoreGate.
     */
    finalOpportunityScore?: number,
    /**
     * Dynamic Risk Tiers (2026-07-23 USOH incident follow-up): the token's
     * age in ms, resolved upstream (worker.ts, via riskTier.ts's
     * resolveTokenAgeMs — which itself fails closed to 0/ULTRA_EARLY when the
     * real on-chain age can't be determined). `undefined` (every existing
     * test/caller that predates this feature) is deliberately treated as
     * "tiering not evaluated for this call" -> ESTABLISHED/no size change,
     * NOT as "unknown -> strictest tier" — that fail-closed behavior belongs
     * to resolveTokenAgeMs itself, upstream, where a real "unknown" and "this
     * caller doesn't participate" are actually distinguishable. Only the real
     * production call site (worker.ts) passes a concrete number.
     */
    tokenAgeMs?: number,
  ) {
    // Two-stage discovery pipeline (2026-07-22): the critical security gate
    // and pre-buy sellability check that used to run here (once per token,
    // AFTER the AI score was already computed) now run in
    // candidatePipeline.ts's runCandidatePipeline, BEFORE the AI provider is
    // ever called — see that module's doc comment. By the time this function
    // runs, both have already passed for this token; this loop only applies
    // each active config's own per-user gates below.
    const configs = await this.deps.prisma.snipeConfig.findMany({
      where: { isActive: true, autoBuyOnLaunch: true },
      include: {
        user: { include: { wallets: { where: { isActive: true } } } },
      },
    });

    const ruleScore = RiskAnalyzer.ruleBasedScore(riskFlags);

    // Dynamic Risk Tiers (2026-07-23 USOH incident follow-up): computed once
    // per token, same as ruleScore above — every config's position size is
    // scaled off the SAME tier, not re-derived per config. Extreme-pump
    // protection (pumpProtection.ts) escalates the tier one notch stricter
    // when riskFlags.extremePumpDetected is set, regardless of the token's
    // actual age — a sudden extreme price move is its own fresh risk event
    // (see riskTier.ts's escalateTierForPump doc comment). This never blocks
    // a buy on its own (see criticalSecurityGate.ts: only a confirmed
    // holderClusteringState==='UNSAFE' finding blocks) — it only shrinks size.
    const baseRiskTier =
      tokenAgeMs === undefined
        ? 'ESTABLISHED'
        : classifyRiskTier(
            tokenAgeMs,
            this.deps.riskTierAgeThresholds ?? DEFAULT_RISK_TIER_AGE_THRESHOLDS,
          );
    const riskTier = riskFlags.extremePumpDetected
      ? escalateTierForPump(baseRiskTier)
      : baseRiskTier;

    // Pipeline checkpoint: Scanner -> AI Filter / Risk Filter. Confirms this function
    // was actually reached for the token and shows the exact numbers every config
    // will be evaluated against, before any per-user gating happens. info (not debug)
    // so this is always visible in production, per the 2026-07-12 root-cause work.
    this.deps.logger.info(
      {
        mint,
        activeConfigCount: configs.length,
        liquidityUsd: riskFlags.liquidityUsd,
        ruleScore,
        aiScore,
        riskTier,
        tokenAgeMs,
        extremePumpDetected: riskFlags.extremePumpDetected ?? false,
      },
      'TOKEN ACCEPTED — evaluating against active auto-buy configs',
    );
    if (configs.length === 0) {
      this.deps.logger.info(
        { mint, location: 'apps/api/src/trading/autoTrader.ts:evaluateAndMaybeBuy' },
        `BUY CANCELLED\nReason:\nno active SnipeConfig has autoBuyOnLaunch enabled — nothing to evaluate this token against`,
      );
    }
    const results: Array<{ userId: string; bought: boolean; reason?: string }> = [];

    for (const config of configs) {
      if (riskFlags.liquidityUsd < config.minLiquidityUsd) {
        logBuyCancelled(this.deps.logger, {
          mint,
          userId: config.userId,
          reason: `liquidity_below_threshold: liquidityUsd=${riskFlags.liquidityUsd} < config.minLiquidityUsd=${config.minLiquidityUsd}`,
          location: 'apps/api/src/trading/autoTrader.ts:evaluateAndMaybeBuy (liquidity gate)',
        });
        results.push({ userId: config.userId, bought: false, reason: 'liquidity_below_threshold' });
        continue;
      }
      // Final Opportunity Score (Section 7, 2026-07-18): opt-in, double-gated
      // exactly like the Smart Entry Filter above — both the global
      // OPPORTUNITY_SCORE_GATE_ENABLED flag AND this config's own
      // useOpportunityScoreGate must be true, and a score must have actually
      // been computed upstream. Any config that hasn't opted in (every
      // existing config, which defaults to false) gets today's exact
      // Math.min(ruleScore, aiScore) gate, unchanged.
      const useOpportunityScoreGate =
        Boolean(this.deps.opportunityScoreGateGloballyEnabled) &&
        config.useOpportunityScoreGate &&
        finalOpportunityScore !== undefined;
      const effectiveScore = useOpportunityScoreGate
        ? finalOpportunityScore
        : Math.min(ruleScore, aiScore);
      if (effectiveScore < config.minAiScore) {
        logBuyCancelled(this.deps.logger, {
          mint,
          userId: config.userId,
          reason: useOpportunityScoreGate
            ? `score_below_threshold: opportunityScore=${effectiveScore} < config.minAiScore=${config.minAiScore}`
            : `score_below_threshold: min(ruleScore=${ruleScore}, aiScore=${aiScore})=${effectiveScore} < config.minAiScore=${config.minAiScore}`,
          location: 'apps/api/src/trading/autoTrader.ts:evaluateAndMaybeBuy (score gate)',
        });
        results.push({ userId: config.userId, bought: false, reason: 'score_below_threshold' });
        continue;
      }

      const entryDecision = evaluateEntry(
        {
          liquidityUsd: riskFlags.liquidityUsd,
          liquiditySource: riskFlags.liquiditySource ?? 'unavailable',
          top10HolderPercent: riskFlags.top10HolderPercent,
          holderCount: riskFlags.holderCount,
          mintAuthorityRevoked: riskFlags.mintAuthorityRevoked,
          freezeAuthorityRevoked: riskFlags.freezeAuthorityRevoked,
          lpBurnedOrLocked: riskFlags.lpBurnedOrLocked,
          isHoneypotSuspected: riskFlags.isHoneypotSuspected,
          recentBuys: riskFlags.recentBuys,
          recentSells: riskFlags.recentSells,
          recentVolumeUsd: riskFlags.recentVolumeUsd,
        },
        {
          enabled: Boolean(this.deps.entryFilterGloballyEnabled) && config.entryFilterEnabled,
          minBuySellRatio: config.minBuySellRatio,
          minHolderCount: config.minHolderCount,
          minRecentVolumeUsd: config.minRecentVolumeUsd,
          maxTop10HolderPercent: config.maxTop10HolderPercent,
        },
      );
      if (!entryDecision.allowed) {
        logBuyCancelled(this.deps.logger, {
          mint,
          userId: config.userId,
          reason: `entry_filter_blocked: ${entryDecision.reasons.join('; ')}`,
          location: 'apps/api/src/trading/autoTrader.ts:evaluateAndMaybeBuy (Smart Entry Filter)',
        });
        results.push({ userId: config.userId, bought: false, reason: 'entry_filter_blocked' });
        continue;
      }

      // A config pinned to a specific wallet (walletId set) uses that wallet as
      // long as it's still active; otherwise (including every pre-existing
      // config, which has walletId = null) this falls back to exactly today's
      // behavior — the user's first active wallet.
      const wallet = config.walletId
        ? (config.user.wallets.find((w) => w.id === config.walletId) ?? config.user.wallets[0])
        : config.user.wallets[0];
      if (!wallet) {
        logBuyCancelled(this.deps.logger, {
          mint,
          userId: config.userId,
          reason: 'no_active_wallet: user has no wallet with isActive=true',
          location: 'apps/api/src/trading/autoTrader.ts:evaluateAndMaybeBuy (wallet check)',
        });
        results.push({ userId: config.userId, bought: false, reason: 'no_active_wallet' });
        continue;
      }

      // TP1 / Breakeven / Trailing exit strategy (2026-07-28/29) — checked
      // BEFORE the preset/manual branch below, double opt-in (this config's
      // own exitStrategy AND the global EXIT_STRATEGY_V2_ENABLED flag).
      // Initial state is SL-only: no takeProfitPercent/trailingStopPercent
      // stored — TP1/breakeven/trailing are all state-driven from
      // Position.trailingActivatedAt (see positionManager.ts's
      // checkAndMaybeCloseTp1Trailing), not pre-computed here. Storing a
      // trailingStopPercent up front would be inert (never read by that
      // path) but misleading on any UI that displays it, so it's left unset.
      const usesTp1TrailingStrategy =
        !!this.deps.exitStrategyV2GloballyEnabled && config.exitStrategy === 'tp1_trailing_v1';
      const exitV2Config = this.deps.exitV2Config ?? DEFAULT_TP1_TRAILING_CONFIG;

      // Optional exit strategy, additive on top of the existing manual TP/SL/
      // trailing fields: only when the config has explicitly opted into a preset
      // (not null, not 'custom') do these get overridden. Anyone who hasn't touched
      // this setting gets exactly today's behavior — config.takeProfitPercent etc,
      // unchanged. See adaptiveTrailingStop.ts.
      const preset = activePreset(config.trailingStopPreset);
      const exitParams = usesTp1TrailingStrategy
        ? {
            takeProfitPercent: undefined,
            stopLossPercent: exitV2Config.initialStopLossPercent,
            trailingStopPercent: undefined,
          }
        : preset
          ? resolvePresetExitParams(preset, {
              liquidityUsd: riskFlags.liquidityUsd,
              top10HolderPercent: riskFlags.top10HolderPercent,
            })
          : {
              takeProfitPercent: config.takeProfitPercent ?? undefined,
              stopLossPercent: config.stopLossPercent ?? undefined,
              trailingStopPercent: config.trailingStopPercent ?? undefined,
            };

      // Dynamic Risk Tiers (2026-07-23): scales the user's OWN configured
      // buyAmountSol down for an early/ultra-early/pump-escalated tier —
      // never a hardcoded absolute size (see riskTier.ts). At the default
      // config, ESTABLISHED is an exact 1.0x no-op, so a config that never
      // buys anything younger than 15min sees no behavior change at all.
      const tieredBuyAmountSol = applyRiskTierSizing(
        config.buyAmountSol,
        riskTier,
        this.deps.riskTierSizeConfig ?? DEFAULT_RISK_TIER_SIZE_CONFIG,
      );

      // Pipeline checkpoint: PositionManager reached — every filter above passed,
      // this config is genuinely about to attempt a real (or paper) buy. info so
      // every attempt is traceable in production, not just its outcome.
      this.deps.logger.info(
        {
          mint,
          userId: config.userId,
          walletId: wallet.id,
          configuredAmountSol: config.buyAmountSol,
          amountSol: tieredBuyAmountSol,
          riskTier,
        },
        'BUY STARTED',
      );
      // Two-stage discovery pipeline (2026-07-22): captured right at this
      // checkpoint, same convention as the other pipeline timestamps — one
      // per token-level attempt (this config's own openPosition call), not
      // remeasured downstream.
      const buySubmittedAt = Date.now();

      try {
        const { trade } = await this.deps.positionManager.openPosition({
          userId: config.userId,
          walletId: wallet.id,
          walletPublicKey: wallet.publicKey,
          encryptedSecret: wallet.encryptedSecret,
          encryptionKey: this.deps.encryptionKey,
          tokenId,
          mint,
          amountSol: tieredBuyAmountSol,
          slippageBps: config.maxSlippageBps,
          trailingStopPreset: preset,
          exitStrategy: usesTp1TrailingStrategy ? 'tp1_trailing_v1' : undefined,
          aiScore,
          // Production bug fix (2026-07-18): this was never passed, leaving
          // riskScoreAtEntry NULL on every auto-bought position (44 of 45 in
          // production at the time this was found) — the one field meant to
          // let a past accept decision be reconstructed later. Same value
          // already used for the score gate above.
          riskScoreAtEntry: Math.min(ruleScore, aiScore),
          ...exitParams,
          tokenDetectedAt: pipelineTimestamps?.tokenDetectedAt,
          analysisStartedAt: pipelineTimestamps?.analysisStartedAt,
          dexValidatedAt: pipelineTimestamps?.dexValidatedAt,
          safetyCompletedAt: pipelineTimestamps?.safetyCompletedAt,
          sellabilityVerifiedAt: pipelineTimestamps?.sellabilityVerifiedAt,
          aiScoringStartAt: pipelineTimestamps?.aiScoringStartAt,
          aiScoringEndAt: pipelineTimestamps?.aiScoringEndAt,
          decisionAt: pipelineTimestamps?.decisionAt,
          buySubmittedAt,
        });
        // positionManager.openPosition itself already logs the canonical
        // "BUY EXECUTED\nSignature:\n<signature>" line; this ties that outcome
        // back to the specific config/user that triggered it.
        this.deps.logger.info(
          { mint, userId: config.userId, signature: trade.txSignature },
          `BUY EXECUTED\nSignature:\n${trade.txSignature}`,
        );
        results.push({ userId: config.userId, bought: true });
      } catch (err) {
        if (err instanceof SafetyCheckError) {
          // Exact gate that blocked this trade (kill switch / per-trade limit / daily
          // loss limit / max open positions / wallet balance) — see safety.ts's
          // checkBeforeOpen, which returns the specific reason string used here.
          // positionManager.openPosition already logged the BUY CANCELLED line for
          // this; this ties it back to the specific config/user.
          this.deps.logger.warn(
            { userId: config.userId, mint, reason: err.reason },
            'auto-buy blocked by safety check',
          );
          if (err.code === 'wallet_balance' && err.details) {
            this.maybeNotifyLowBalance(config.userId, err.details);
          }
          results.push({ userId: config.userId, bought: false, reason: 'safety_blocked' });
          continue;
        }
        if (err instanceof SellabilityCheckError) {
          // positionManager.openPositionLocked already logged the BUY CANCELLED
          // line and notified for this — ties it back to the specific config/user.
          this.deps.logger.warn(
            { userId: config.userId, mint, reasonCode: err.reasonCode },
            'auto-buy blocked by pre-buy sellability check',
          );
          results.push({ userId: config.userId, bought: false, reason: 'not_sellable' });
          continue;
        }
        logBuyCancelled(this.deps.logger, {
          mint,
          userId: config.userId,
          reason: `execution_error: ${err instanceof Error ? err.message : String(err)}`,
          location: 'apps/api/src/trading/autoTrader.ts:evaluateAndMaybeBuy (openPosition catch)',
          err,
        });
        results.push({ userId: config.userId, bought: false, reason: 'execution_error' });
      }
    }

    this.deps.logger.info({ mint, results }, 'AutoTrader.evaluateAndMaybeBuy complete');
    return results;
  }

  /**
   * Fire-and-forget, deduped per user via lowBalanceNotifiedCache — see its
   * TTL comment above. Not awaited by the caller: a Telegram send stalling
   * shouldn't hold up evaluating this token against the remaining configs.
   */
  private maybeNotifyLowBalance(
    userId: string,
    details: { balanceSol: number; requiredSol: number },
  ): void {
    if (!this.deps.notifier || this.lowBalanceNotifiedCache.has(userId)) return;
    this.lowBalanceNotifiedCache.add(userId);
    this.deps.notifier.notifyLowWalletBalance(userId, details).catch((err) => {
      this.deps.logger.error({ err, userId }, 'failed to send low-balance notification');
    });
  }
}
