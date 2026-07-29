/**
 * Trade replay + missed-profit analysis (Phase 7c, 2026-07-29) — reruns a
 * single historical price series through the exact same evaluateExit logic
 * the live PriceMonitor uses (same as backtest.ts, one candle at a time),
 * but keeps the full step-by-step trace rather than only the final outcome —
 * built for post-mortem/debugging ("why did this exit fire when it did") and
 * for missed-profit analysis, neither of which backtest.ts's single-result
 * shape supports.
 */
import { evaluateExit, type EvaluateExitReason } from './exitEngine.js';
import type { BacktestConfig, PriceCandle } from './backtest.js';

export interface ReplayStep {
  index: number;
  timestamp: number;
  priceUsd: number;
  highWaterMarkUsd: number;
  pnlPercent: number;
  shouldExit: boolean;
  reason?: EvaluateExitReason;
}

export interface TradeReplayResult {
  steps: ReplayStep[];
  exitReason: EvaluateExitReason | 'end_of_data';
  exitIndex: number;
  exitPriceUsd: number;
  exitPnlPercent: number;
}

/**
 * Same exit logic and semantics as backtest.ts's runBacktest (stops at the
 * first candle that trips an exit rule, or falls through to `end_of_data`),
 * but returns one ReplayStep per candle actually evaluated — this is the
 * "decision trace" a replay UI or debugging script wants.
 */
export function replayTrade(candles: PriceCandle[], config: BacktestConfig): TradeReplayResult {
  let highWaterMarkUsd = config.entryPriceUsd;
  const steps: ReplayStep[] = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    const decision = evaluateExit({
      entryPriceUsd: config.entryPriceUsd,
      currentPriceUsd: candle.priceUsd,
      highWaterMarkUsd,
      takeProfitPercent: config.takeProfitPercent,
      stopLossPercent: config.stopLossPercent,
      trailingStopPercent: config.trailingStopPercent,
    });
    highWaterMarkUsd = decision.newHighWaterMarkUsd;

    steps.push({
      index: i,
      timestamp: candle.timestamp,
      priceUsd: candle.priceUsd,
      highWaterMarkUsd,
      pnlPercent: decision.pnlPercent,
      shouldExit: decision.shouldExit,
      reason: decision.reason,
    });

    if (decision.shouldExit) {
      return {
        steps,
        exitReason: decision.reason!,
        exitIndex: i,
        exitPriceUsd: candle.priceUsd,
        exitPnlPercent: decision.pnlPercent,
      };
    }
  }

  const last = candles.at(-1);
  const exitPriceUsd = last?.priceUsd ?? config.entryPriceUsd;
  const exitPnlPercent =
    config.entryPriceUsd > 0
      ? ((exitPriceUsd - config.entryPriceUsd) / config.entryPriceUsd) * 100
      : 0;

  return {
    steps,
    exitReason: 'end_of_data',
    exitIndex: Math.max(candles.length - 1, 0),
    exitPriceUsd,
    exitPnlPercent,
  };
}

export interface MissedProfitAnalysis {
  /** Highest price observed anywhere in `candles` strictly after the actual
   * exit index. Undefined when the exit was the last candle (nothing after
   * it to have missed). */
  peakPriceAfterExitUsd: number | undefined;
  /** How much additional pnlPercent was available between the actual exit
   * and that later peak — 0 when there was nothing after the exit, or when
   * the peak never exceeded the exit price (the exit was already optimal or
   * near-optimal). Never negative. */
  missedProfitPercent: number;
  /** Index into `candles` where peakPriceAfterExitUsd occurred, or undefined
   * to match peakPriceAfterExitUsd. */
  peakIndex: number | undefined;
}

/**
 * Replays the series to find where the strategy actually exited, then scans
 * every candle strictly after that point for a higher price than the exit —
 * "how much did we leave on the table by exiting when we did." Deliberately
 * looks only forward from the real exit (not the theoretical global peak of
 * the whole series), since a strategy can't be faulted for missing a rally
 * that happened before it ever had a position open... this only measures
 * upside that existed AFTER the exit decision, which is the only upside a
 * different exit rule could actually have captured.
 */
export function analyzeMissedProfit(
  candles: PriceCandle[],
  config: BacktestConfig,
): MissedProfitAnalysis {
  const replay = replayTrade(candles, config);
  const remaining = candles.slice(replay.exitIndex + 1);

  if (remaining.length === 0) {
    return { peakPriceAfterExitUsd: undefined, missedProfitPercent: 0, peakIndex: undefined };
  }

  let peak = remaining[0]!;
  let peakOffset = 0;
  for (let i = 1; i < remaining.length; i++) {
    if (remaining[i]!.priceUsd > peak.priceUsd) {
      peak = remaining[i]!;
      peakOffset = i;
    }
  }

  const missedProfitPercent = Math.max(
    0,
    ((peak.priceUsd - replay.exitPriceUsd) / replay.exitPriceUsd) * 100,
  );

  return {
    peakPriceAfterExitUsd: peak.priceUsd,
    missedProfitPercent,
    peakIndex: replay.exitIndex + 1 + peakOffset,
  };
}
