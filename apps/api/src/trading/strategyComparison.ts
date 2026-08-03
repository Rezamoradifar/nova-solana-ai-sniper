/**
 * Strategy comparison + optimization (Phase 7c, 2026-07-29) — built on
 * backtest.ts's runBacktest: given the SAME set of historical price series
 * (real OHLCV candle runs, one per historical trade), evaluates multiple
 * BacktestConfigs and compares them "paired" (every series is replayed under
 * every config, so a difference in the result is attributable to the config,
 * not to one strategy getting an easier set of trades than the other).
 */
import { runBacktest, type BacktestConfig, type PriceCandle } from './backtest.js';
import {
  summarizePerformance,
  type PerformanceSummary,
  type TradeOutcome,
} from './backtestMetrics.js';

function toOutcomes(series: PriceCandle[][], config: BacktestConfig): TradeOutcome[] {
  return series.map((candles) => {
    const result = runBacktest(candles, config);
    return { pnlPercent: result.pnlPercent, pnlAmount: result.pnlSol };
  });
}

export interface StrategyComparisonResult {
  a: PerformanceSummary;
  b: PerformanceSummary;
  /** Count of series where each config produced the strictly higher
   * pnlPercent on that exact series ("paired win"), plus ties. Sums to
   * series.length. */
  pairedWins: { a: number; b: number; ties: number };
  /** 'a' | 'b' | 'tie' — picked by profit factor first (the metric most
   * sensitive to a strategy's actual risk/reward shape), falling back to win
   * rate when profit factor ties (including the both-Infinity case). */
  winner: 'a' | 'b' | 'tie';
}

/**
 * Runs both configs against the identical series list and compares the
 * resulting performance summaries. `series` should be real historical OHLCV
 * runs (e.g. one per past position's holding window) — a config compared
 * against synthetic/fabricated candles tells you nothing about how it will
 * perform on real tokens.
 */
export function compareStrategies(
  series: PriceCandle[][],
  configA: BacktestConfig,
  configB: BacktestConfig,
): StrategyComparisonResult {
  const outcomesA = toOutcomes(series, configA);
  const outcomesB = toOutcomes(series, configB);

  let winsA = 0;
  let winsB = 0;
  let ties = 0;
  for (let i = 0; i < series.length; i++) {
    const pnlA = outcomesA[i]!.pnlPercent;
    const pnlB = outcomesB[i]!.pnlPercent;
    if (pnlA > pnlB) winsA++;
    else if (pnlB > pnlA) winsB++;
    else ties++;
  }

  const a = summarizePerformance(outcomesA);
  const b = summarizePerformance(outcomesB);

  let winner: 'a' | 'b' | 'tie' = 'tie';
  if (a.profitFactor !== b.profitFactor) {
    winner = a.profitFactor > b.profitFactor ? 'a' : 'b';
  } else if (a.winRate !== b.winRate) {
    winner = a.winRate > b.winRate ? 'a' : 'b';
  }

  return { a, b, pairedWins: { a: winsA, b: winsB, ties }, winner };
}

export interface OptimizationCandidateRanges {
  takeProfitPercent?: number[];
  stopLossPercent?: number[];
  trailingStopPercent?: number[];
}

export interface OptimizationCandidateResult {
  config: BacktestConfig;
  summary: PerformanceSummary;
}

export interface OptimizationResult {
  best: OptimizationCandidateResult | undefined;
  /** Every candidate tried, sorted best-first (profit factor, then win
   * rate) — capped to the top 10 so a large grid doesn't produce an
   * unbounded response. */
  ranked: OptimizationCandidateResult[];
  recommendation: string;
}

/**
 * Bounded grid search: tries every combination of the caller-supplied
 * candidate values (never invents its own search space — an unconstrained
 * optimizer over a noisy backtest is how you overfit to historical noise),
 * evaluates each against the same series list via compareStrategies's own
 * outcome-building logic, and ranks by profit factor. Any axis omitted from
 * `ranges` is held fixed at baseConfig's own value.
 */
export function recommendOptimalConfig(
  series: PriceCandle[][],
  baseConfig: BacktestConfig,
  ranges: OptimizationCandidateRanges,
): OptimizationResult {
  if (series.length === 0) {
    return {
      best: undefined,
      ranked: [],
      recommendation: 'No historical series provided — nothing to optimize against.',
    };
  }

  const tpValues = ranges.takeProfitPercent ?? [baseConfig.takeProfitPercent];
  const slValues = ranges.stopLossPercent ?? [baseConfig.stopLossPercent];
  const trailValues = ranges.trailingStopPercent ?? [baseConfig.trailingStopPercent];

  const candidates: OptimizationCandidateResult[] = [];
  for (const takeProfitPercent of tpValues) {
    for (const stopLossPercent of slValues) {
      for (const trailingStopPercent of trailValues) {
        const config: BacktestConfig = {
          ...baseConfig,
          takeProfitPercent,
          stopLossPercent,
          trailingStopPercent,
        };
        const outcomes = toOutcomes(series, config);
        candidates.push({ config, summary: summarizePerformance(outcomes) });
      }
    }
  }

  const ranked = [...candidates].sort((x, y) => {
    if (y.summary.profitFactor !== x.summary.profitFactor) {
      return y.summary.profitFactor - x.summary.profitFactor;
    }
    return y.summary.winRate - x.summary.winRate;
  });

  const best = ranked[0];
  const baseline = summarizePerformance(toOutcomes(series, baseConfig));
  let recommendation: string;
  if (!best || series.length === 0) {
    recommendation = 'No historical series provided — nothing to optimize against.';
  } else if (best.summary.profitFactor > baseline.profitFactor) {
    recommendation =
      `Candidate TP=${best.config.takeProfitPercent ?? 'none'}% / ` +
      `SL=${best.config.stopLossPercent ?? 'none'}% / ` +
      `Trail=${best.config.trailingStopPercent ?? 'none'}% improves profit factor from ` +
      `${baseline.profitFactor.toFixed(2)} to ${best.summary.profitFactor.toFixed(2)} ` +
      `across ${series.length} historical trades — worth validating live before adopting.`;
  } else {
    recommendation =
      'The current configuration already outperforms every tried candidate on this data.';
  }

  return { best, ranked: ranked.slice(0, 10), recommendation };
}
