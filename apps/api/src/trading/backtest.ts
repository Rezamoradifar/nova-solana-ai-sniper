import { evaluateExit } from './exitEngine.js';

export interface PriceCandle {
  timestamp: number;
  priceUsd: number;
}

export interface BacktestConfig {
  entryPriceUsd: number;
  amountSolInvested: number;
  takeProfitPercent?: number;
  stopLossPercent?: number;
  trailingStopPercent?: number;
}

export interface BacktestResult {
  exitPriceUsd: number;
  exitReason: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'end_of_data';
  pnlPercent: number;
  pnlSol: number;
  candlesHeld: number;
}

/**
 * Replays a historical price series through the same `evaluateExit` logic
 * used live, so strategies can be validated before risking real capital.
 */
export function runBacktest(candles: PriceCandle[], config: BacktestConfig): BacktestResult {
  let highWaterMarkUsd = config.entryPriceUsd;

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

    if (decision.shouldExit) {
      return {
        exitPriceUsd: candle.priceUsd,
        exitReason: decision.reason!,
        pnlPercent: decision.pnlPercent,
        pnlSol: config.amountSolInvested * (decision.pnlPercent / 100),
        candlesHeld: i + 1,
      };
    }
  }

  const lastPrice = candles.at(-1)?.priceUsd ?? config.entryPriceUsd;
  const pnlPercent = ((lastPrice - config.entryPriceUsd) / config.entryPriceUsd) * 100;

  return {
    exitPriceUsd: lastPrice,
    exitReason: 'end_of_data',
    pnlPercent,
    pnlSol: config.amountSolInvested * (pnlPercent / 100),
    candlesHeld: candles.length,
  };
}

export function runBacktestBatch(
  series: PriceCandle[][],
  config: BacktestConfig,
): { results: BacktestResult[]; winRate: number; avgPnlPercent: number } {
  const results = series.map((candles) => runBacktest(candles, config));
  const wins = results.filter((r) => r.pnlPercent > 0).length;
  const avgPnlPercent = results.reduce((sum, r) => sum + r.pnlPercent, 0) / (results.length || 1);
  return { results, winRate: results.length ? wins / results.length : 0, avgPnlPercent };
}
