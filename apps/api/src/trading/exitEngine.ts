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
  const pnlPercent = ((input.currentPriceUsd - input.entryPriceUsd) / input.entryPriceUsd) * 100;

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
