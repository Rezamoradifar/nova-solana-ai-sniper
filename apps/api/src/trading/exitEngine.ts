export interface ExitCheckInput {
  entryPriceUsd: number;
  currentPriceUsd: number;
  highWaterMarkUsd: number;
  takeProfitPercent?: number | null;
  stopLossPercent?: number | null;
  trailingStopPercent?: number | null;
}

export type ExitReason = 'take_profit' | 'stop_loss' | 'trailing_stop';

export interface ExitDecision {
  shouldExit: boolean;
  reason?: ExitReason;
  newHighWaterMarkUsd: number;
  pnlPercent: number;
}

/**
 * Pure function so TP/SL/trailing-stop logic can be exhaustively unit tested
 * without touching the DB or an RPC connection. Called on every price tick.
 */
export function evaluateExit(input: ExitCheckInput): ExitDecision {
  // A zero/negative entry price means it's genuinely unknown (never divide by it — that
  // produces Infinity/NaN, which trivially "beats" any take-profit/stop-loss threshold
  // and fires an exit that has nothing to do with real price movement). Treat it as 0%
  // PnL instead: neither TP nor SL can fire off a made-up number, while trailing-stop
  // (which only compares currentPriceUsd against its own high-water mark, not entry)
  // is unaffected and keeps working.
  const pnlPercent =
    input.entryPriceUsd > 0
      ? ((input.currentPriceUsd - input.entryPriceUsd) / input.entryPriceUsd) * 100
      : 0;

  const newHighWaterMarkUsd = Math.max(input.highWaterMarkUsd, input.currentPriceUsd);

  if (input.takeProfitPercent != null && pnlPercent >= input.takeProfitPercent) {
    return { shouldExit: true, reason: 'take_profit', newHighWaterMarkUsd, pnlPercent };
  }

  if (input.stopLossPercent != null && pnlPercent <= -Math.abs(input.stopLossPercent)) {
    return { shouldExit: true, reason: 'stop_loss', newHighWaterMarkUsd, pnlPercent };
  }

  if (input.trailingStopPercent != null) {
    const dropFromHighPercent =
      ((newHighWaterMarkUsd - input.currentPriceUsd) / newHighWaterMarkUsd) * 100;
    if (dropFromHighPercent >= input.trailingStopPercent) {
      return { shouldExit: true, reason: 'trailing_stop', newHighWaterMarkUsd, pnlPercent };
    }
  }

  return { shouldExit: false, newHighWaterMarkUsd, pnlPercent };
}
