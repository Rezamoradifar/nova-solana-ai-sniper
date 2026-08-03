import type { Logger } from '@nova/shared';
import type { SmartWalletTrackerService } from './smartWalletTracker.js';
import type { EarlyMomentumDetectorService } from './earlyMomentumDetector.js';
import {
  detectWashTradingPattern,
  type BuyEvent,
  type EarlyMomentumMetrics,
} from './earlyMomentumDetector.js';

/**
 * Thin orchestration layer combining SmartWalletTracker + EarlyMomentumDetector
 * (Sections 3-4, 2026-07-22) — kept out of worker.ts so the wiring itself is
 * unit-testable via mocked deps, same DI convention as candidatePipeline.ts's
 * CandidatePipelineDeps. Runs strictly downstream of the critical security
 * gate (only ever called for a `passed: true` candidate — see worker.ts) and
 * has no ability to affect that gate's verdict.
 *
 * Wallet evaluation and the DexScreener pair fetch run concurrently
 * (Promise.allSettled, matching candidatePipeline.ts's own convention) —
 * momentum's *scoring* still depends on wallet evaluation's buyer list for
 * its smart-money/wash-trade sub-metrics, but that's a pure, synchronous
 * combination step (scoreFromPair), not a second network wait. Each I/O call
 * is individually bounded (EVALUATION_TIMEOUT_MS) so a slow RPC/DexScreener
 * response degrades to "score unavailable," never blocks. This whole
 * function is called fire-and-forget from the discovery path (see
 * worker.ts), never awaited before the AI queue is fed, so it can never slow
 * the existing fast path.
 */

const EVALUATION_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

export interface SmartMoneyMomentumDeps {
  smartWalletTracker: SmartWalletTrackerService;
  earlyMomentumDetector: EarlyMomentumDetectorService;
  logger: Logger;
  smartMoneyEnabled: boolean;
  momentumEnabled: boolean;
}

export interface SmartMoneyMomentumInput {
  mint: string;
  tokenId: string;
  poolCreatedAtMs?: number;
}

export interface SmartMoneyMomentumResult {
  smartMoneyScore?: number;
  earlyMomentumScore?: number;
  smartMoneyClusterBuy: boolean;
  clusterWalletCount?: number;
  sybilDiscountApplied: boolean;
  momentumBreakdown?: EarlyMomentumMetrics;
  /** Surfaced from the momentum pair fetch (already made regardless) so the
   * shadow-mode logger doesn't need a second DexScreener call just to record
   * priceAtDetectionUsd. */
  priceUsd?: number;
}

const EMPTY_RESULT: SmartMoneyMomentumResult = {
  smartMoneyClusterBuy: false,
  sybilDiscountApplied: false,
};

export async function evaluateSmartMoneyAndMomentum(
  deps: SmartMoneyMomentumDeps,
  input: SmartMoneyMomentumInput,
): Promise<SmartMoneyMomentumResult> {
  if (!deps.smartMoneyEnabled && !deps.momentumEnabled) return EMPTY_RESULT;

  const [walletSettled, pairSettled] = await Promise.allSettled([
    deps.smartMoneyEnabled
      ? withTimeout(
          deps.smartWalletTracker.evaluateForToken(
            input.mint,
            input.tokenId,
            input.poolCreatedAtMs,
          ),
          EVALUATION_TIMEOUT_MS,
        )
      : Promise.resolve(undefined),
    deps.momentumEnabled
      ? withTimeout(deps.earlyMomentumDetector.fetchPair(input.mint), EVALUATION_TIMEOUT_MS)
      : Promise.resolve(undefined),
  ]);

  if (walletSettled.status === 'rejected') {
    deps.logger.debug(
      { mint: input.mint, err: walletSettled.reason },
      'smartMoneyMomentumEvaluator: wallet evaluation failed',
    );
  }
  if (pairSettled.status === 'rejected') {
    deps.logger.debug(
      { mint: input.mint, err: pairSettled.reason },
      'smartMoneyMomentumEvaluator: pair fetch failed',
    );
  }

  const walletEvaluation = walletSettled.status === 'fulfilled' ? walletSettled.value : undefined;
  const pair = pairSettled.status === 'fulfilled' ? pairSettled.value : undefined;

  const uniqueBuyerCount = walletEvaluation
    ? new Set(walletEvaluation.buyEvents.map((e) => e.walletAddress)).size
    : undefined;
  const repeatedBuyerRatioPct =
    walletEvaluation && walletEvaluation.buyEvents.length > 0 && uniqueBuyerCount !== undefined
      ? ((walletEvaluation.buyEvents.length - uniqueBuyerCount) /
          walletEvaluation.buyEvents.length) *
        100
      : undefined;

  let washTradeSuspicionPct: number | undefined;
  if (walletEvaluation && walletEvaluation.buyEvents.length > 0) {
    const events: BuyEvent[] = walletEvaluation.buyEvents.map((e) => ({
      walletAddress: e.walletAddress,
      side: 'buy',
      timestampMs: e.timestampMs,
    }));
    washTradeSuspicionPct = detectWashTradingPattern(events).suspicionPct;
  }

  const momentumResult = deps.momentumEnabled
    ? deps.earlyMomentumDetector.scoreFromPair(pair, {
        uniqueBuyerCount,
        repeatedBuyerRatioPct,
        washTradeSuspicionPct,
      })
    : undefined;

  return {
    smartMoneyScore: walletEvaluation?.smartMoneyScore,
    earlyMomentumScore: momentumResult?.score,
    smartMoneyClusterBuy: walletEvaluation?.clusterBuy.isClusterBuy ?? false,
    clusterWalletCount: walletEvaluation?.clusterBuy.independentClusterCount,
    sybilDiscountApplied: walletEvaluation?.sybilDiscountApplied ?? false,
    momentumBreakdown: momentumResult?.breakdown,
    priceUsd: momentumResult?.priceUsd,
  };
}
