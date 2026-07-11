import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { RiskFlags } from '@nova/shared';
import { RiskAnalyzer } from '../detection/riskAnalyzer.js';
import type { PositionManager } from './positionManager.js';
import { SafetyCheckError } from './safety.js';
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
}

/**
 * Evaluates a freshly-detected token launch against every active auto-buy
 * SnipeConfig and fires an open-position call for each one that passes its
 * own thresholds. Configs are per-user, so one loose config doesn't cause
 * every user's wallet to buy.
 */
export class AutoTrader {
  constructor(private readonly deps: AutoTraderDeps) {}

  async evaluateAndMaybeBuy(mint: string, tokenId: string, riskFlags: RiskFlags, aiScore: number) {
    const configs = await this.deps.prisma.snipeConfig.findMany({
      where: { isActive: true, autoBuyOnLaunch: true },
      include: {
        user: { include: { wallets: { where: { isActive: true } } } },
      },
    });

    const ruleScore = RiskAnalyzer.ruleBasedScore(riskFlags);
    // Pipeline checkpoint: Scanner -> AI Filter / Risk Filter. Confirms this function
    // was actually reached for the token and shows the exact numbers every config
    // will be evaluated against, before any per-user gating happens.
    this.deps.logger.debug(
      {
        mint,
        activeConfigCount: configs.length,
        liquidityUsd: riskFlags.liquidityUsd,
        ruleScore,
        aiScore,
      },
      'AutoTrader.evaluateAndMaybeBuy reached — evaluating active configs',
    );
    const results: Array<{ userId: string; bought: boolean; reason?: string }> = [];

    for (const config of configs) {
      if (riskFlags.liquidityUsd < config.minLiquidityUsd) {
        this.deps.logger.debug(
          {
            mint,
            userId: config.userId,
            liquidityUsd: riskFlags.liquidityUsd,
            minLiquidityUsd: config.minLiquidityUsd,
          },
          "Risk Filter: liquidity below this config's threshold — skipping",
        );
        results.push({ userId: config.userId, bought: false, reason: 'liquidity_below_threshold' });
        continue;
      }
      if (Math.min(ruleScore, aiScore) < config.minAiScore) {
        this.deps.logger.debug(
          {
            mint,
            userId: config.userId,
            ruleScore,
            aiScore,
            minAiScore: config.minAiScore,
          },
          "AI Filter: combined score below this config's threshold — skipping",
        );
        results.push({ userId: config.userId, bought: false, reason: 'score_below_threshold' });
        continue;
      }
      const wallet = config.user.wallets[0];
      if (!wallet) {
        this.deps.logger.debug(
          { mint, userId: config.userId },
          'Wallet: no active wallet for this user — skipping',
        );
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
      // this config is genuinely about to attempt a real (or paper) buy.
      this.deps.logger.debug(
        { mint, userId: config.userId, walletId: wallet.id, amountSol: config.buyAmountSol },
        'PositionManager reached — attempting openPosition',
      );

      try {
        await this.deps.positionManager.openPosition({
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
        });
        this.deps.logger.debug(
          { mint, userId: config.userId },
          'Buy Executor: openPosition succeeded',
        );
        results.push({ userId: config.userId, bought: true });
      } catch (err) {
        if (err instanceof SafetyCheckError) {
          // Exact gate that blocked this trade (kill switch / per-trade limit / daily
          // loss limit / max open positions / wallet balance) — see safety.ts's
          // checkBeforeOpen, which returns the specific reason string used here.
          this.deps.logger.warn(
            { userId: config.userId, mint, reason: err.reason },
            'auto-buy blocked by safety check',
          );
          results.push({ userId: config.userId, bought: false, reason: 'safety_blocked' });
          continue;
        }
        this.deps.logger.error({ err, userId: config.userId, mint }, 'auto-buy failed');
        results.push({ userId: config.userId, bought: false, reason: 'execution_error' });
      }
    }

    this.deps.logger.debug({ mint, results }, 'AutoTrader.evaluateAndMaybeBuy complete');
    return results;
  }
}
