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
    const results: Array<{ userId: string; bought: boolean; reason?: string }> = [];

    for (const config of configs) {
      if (riskFlags.liquidityUsd < config.minLiquidityUsd) {
        results.push({ userId: config.userId, bought: false, reason: 'liquidity_below_threshold' });
        continue;
      }
      if (Math.min(ruleScore, aiScore) < config.minAiScore) {
        results.push({ userId: config.userId, bought: false, reason: 'score_below_threshold' });
        continue;
      }
      const wallet = config.user.wallets[0];
      if (!wallet) {
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
          ...exitParams,
        });
        results.push({ userId: config.userId, bought: true });
      } catch (err) {
        if (err instanceof SafetyCheckError) {
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

    return results;
  }
}
