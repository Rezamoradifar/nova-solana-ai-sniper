/**
 * Aggregate performance metrics (Phase 7b, 2026-07-29) — computed from a flat
 * list of trade outcomes, so the same functions work whether the caller is
 * summarizing runBacktest results (see backtest.ts, pnlAmount in SOL) or real
 * closed Position rows (pnlAmount in USD, via realizedPnlUsd) — deliberately
 * unit-agnostic; callers pick the unit and every returned amount stays in
 * that same unit.
 */

export interface TradeOutcome {
  pnlPercent: number;
  /** Caller-defined unit — SOL for a backtest run, USD for real positions. */
  pnlAmount: number;
}

export function calculateWinRate(trades: TradeOutcome[]): number {
  if (trades.length === 0) return 0;
  return trades.filter((t) => t.pnlAmount > 0).length / trades.length;
}

/** Total PnL as a percent of total capital deployed. `totalInvested` must be
 * in the same unit as each trade's pnlAmount (e.g. total SOL invested across
 * all backtested entries, or total USD cost basis across all real trades). */
export function calculateRoi(trades: TradeOutcome[], totalInvested: number): number {
  if (totalInvested <= 0) return 0;
  const totalPnl = trades.reduce((sum, t) => sum + t.pnlAmount, 0);
  return (totalPnl / totalInvested) * 100;
}

/** Gross profit / gross loss. Undefined (Infinity) when there are wins and
 * zero losses — reported as `Infinity`, not clamped, since that's the
 * mathematically correct value (no losses to divide by) and callers should
 * treat it as "no downside observed yet," not a normal ratio. */
export function calculateProfitFactor(trades: TradeOutcome[]): number {
  const grossProfit = trades.filter((t) => t.pnlAmount > 0).reduce((s, t) => s + t.pnlAmount, 0);
  const grossLoss = Math.abs(
    trades.filter((t) => t.pnlAmount < 0).reduce((s, t) => s + t.pnlAmount, 0),
  );
  if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0;
  return grossProfit / grossLoss;
}

export interface DrawdownResult {
  /** Largest peak-to-trough decline in the cumulative-PnL equity curve
   * (built by summing trades in the given order — callers should pass
   * trades in chronological order for this to mean anything). Same unit as
   * pnlAmount. */
  maxDrawdownAmount: number;
  /** maxDrawdownAmount as a percent of the peak equity it dropped from —
   * 0 when the peak itself is <= 0 (nothing meaningful to express as a
   * percent of a non-positive base). */
  maxDrawdownPercent: number;
}

/**
 * Walks the cumulative-PnL curve (starting at 0, one step per trade, in
 * input order) tracking the running peak and the largest drop below it —
 * the standard trading "max drawdown" definition, applied to realized trade
 * PnL rather than a mark-to-market account balance (this codebase has no
 * continuously-marked equity curve to draw from).
 */
export function calculateMaxDrawdown(trades: TradeOutcome[]): DrawdownResult {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownAmount = 0;
  let maxDrawdownPercent = 0;

  for (const trade of trades) {
    cumulative += trade.pnlAmount;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdownAmount) {
      maxDrawdownAmount = drawdown;
      maxDrawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0;
    }
  }

  return { maxDrawdownAmount, maxDrawdownPercent };
}

/**
 * Per-trade Sharpe ratio: mean(pnlPercent) / stdev(pnlPercent), using
 * pnlPercent (not pnlAmount) so it's comparable across differently-sized
 * trades. Deliberately NOT annualized — trades in this system don't occur on
 * a fixed periodicity (a memecoin snipe can close in seconds or days), so
 * any annualization factor would be a fabricated assumption. 0 when there
 * are fewer than 2 trades (no variance to compute) or when variance is 0
 * (every trade had identical pnlPercent — reported as 0, not Infinity/NaN).
 */
export function calculateSharpeRatio(trades: TradeOutcome[], riskFreeRatePercent = 0): number {
  if (trades.length < 2) return 0;
  const returns = trades.map((t) => t.pnlPercent - riskFreeRatePercent);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return 0;
  return mean / stdev;
}

export interface PerformanceSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlAmount: number;
  avgPnlPercent: number;
  roi: number;
  profitFactor: number;
  maxDrawdownAmount: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
}

/**
 * The single call site most callers want: every metric above, computed once
 * over the same trade list. `totalInvested` feeds calculateRoi — pass 0 (the
 * default) when the caller doesn't have a meaningful total-capital figure,
 * which makes `roi` report 0 rather than throwing.
 */
export function summarizePerformance(
  trades: TradeOutcome[],
  totalInvested = 0,
): PerformanceSummary {
  const wins = trades.filter((t) => t.pnlAmount > 0).length;
  const totalPnlAmount = trades.reduce((sum, t) => sum + t.pnlAmount, 0);
  const avgPnlPercent =
    trades.length > 0 ? trades.reduce((sum, t) => sum + t.pnlPercent, 0) / trades.length : 0;
  const drawdown = calculateMaxDrawdown(trades);

  return {
    totalTrades: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: calculateWinRate(trades),
    totalPnlAmount,
    avgPnlPercent,
    roi: calculateRoi(trades, totalInvested),
    profitFactor: calculateProfitFactor(trades),
    maxDrawdownAmount: drawdown.maxDrawdownAmount,
    maxDrawdownPercent: drawdown.maxDrawdownPercent,
    sharpeRatio: calculateSharpeRatio(trades),
  };
}
