import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { RiskFlags } from '@nova/shared';
import { RiskAnalyzer } from '../detection/riskAnalyzer.js';
import type { PositionManager } from './positionManager.js';
import { SafetyCheckError } from './safety.js';
import { evaluateEntry } from './entryFilter.js';
import {
  resolvePresetExitParams,
  TRAILING_STOP_PRESETS,
  type TrailingStopPreset,
} from './adaptiveTrailingStop.js';

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
}

/**
 * Evaluates a freshly-detected token launch against every active auto-buy
 * SnipeConfig and fires an open-position call for each one that passes its
 * own thresholds. Configs are per-user, so one loose config doesn't cause
 * every user's wallet to buy.
 */
export class AutoTrader {
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
    },
  ) {
    const configs = await this.deps.prisma.snipeConfig.findMany({
      where: { isActive: true, autoBuyOnLaunch: true },
      include: {
        user: { include: { wallets: { where: { isActive: true } } } },
      },
    });

    const ruleScore = RiskAnalyzer.ruleBasedScore(riskFlags);
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
      if (Math.min(ruleScore, aiScore) < config.minAiScore) {
        logBuyCancelled(this.deps.logger, {
          mint,
          userId: config.userId,
          reason: `score_below_threshold: min(ruleScore=${ruleScore}, aiScore=${aiScore})=${Math.min(ruleScore, aiScore)} < config.minAiScore=${config.minAiScore}`,
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

      const wallet = config.user.wallets[0];
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

      // Optional exit strategy, additive on top of the existing manual TP/SL/
      // trailing fields: only when the config has explicitly opted into a preset
      // (not null, not 'custom') do these get overridden. Anyone who hasn't touched
      // this setting gets exactly today's behavior — config.takeProfitPercent etc,
      // unchanged. See adaptiveTrailingStop.ts.
      const preset = activePreset(config.trailingStopPreset);
      const exitParams = preset
        ? resolvePresetExitParams(preset, {
            liquidityUsd: riskFlags.liquidityUsd,
            top10HolderPercent: riskFlags.top10HolderPercent,
          })
        : {
            takeProfitPercent: config.takeProfitPercent ?? undefined,
            stopLossPercent: config.stopLossPercent ?? undefined,
            trailingStopPercent: config.trailingStopPercent ?? undefined,
          };

      // Pipeline checkpoint: PositionManager reached — every filter above passed,
      // this config is genuinely about to attempt a real (or paper) buy. info so
      // every attempt is traceable in production, not just its outcome.
      this.deps.logger.info(
        { mint, userId: config.userId, walletId: wallet.id, amountSol: config.buyAmountSol },
        'BUY STARTED',
      );

      try {
        const { trade } = await this.deps.positionManager.openPosition({
          userId: config.userId,
          walletId: wallet.id,
          walletPublicKey: wallet.publicKey,
          encryptedSecret: wallet.encryptedSecret,
          encryptionKey: this.deps.encryptionKey,
          tokenId,
          mint,
          amountSol: config.buyAmountSol,
          slippageBps: config.maxSlippageBps,
          trailingStopPreset: preset,
          aiScore,
          ...exitParams,
          tokenDetectedAt: pipelineTimestamps?.tokenDetectedAt,
          aiScoringStartAt: pipelineTimestamps?.aiScoringStartAt,
          aiScoringEndAt: pipelineTimestamps?.aiScoringEndAt,
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
          results.push({ userId: config.userId, bought: false, reason: 'safety_blocked' });
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
}
