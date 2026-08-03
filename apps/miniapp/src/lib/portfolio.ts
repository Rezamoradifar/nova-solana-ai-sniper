import { isFiniteNumber } from './format.js';
import type { PortfolioSummary } from './types.js';

/** Aggregate GET /portfolio's real per-wallet array into one total — see
 * PortfolioSummaryList's doc comment in types.ts for why this array shape
 * exists and must never be treated as a single object. */
export function aggregatePortfolio(summaries: PortfolioSummary[]): PortfolioSummary {
  return summaries.reduce<PortfolioSummary>(
    (total, s) => ({
      walletId: 'all',
      openPositions: total.openPositions + (isFiniteNumber(s.openPositions) ? s.openPositions : 0),
      totalInvestedSol:
        total.totalInvestedSol + (isFiniteNumber(s.totalInvestedSol) ? s.totalInvestedSol : 0),
      realizedPnlUsd:
        total.realizedPnlUsd + (isFiniteNumber(s.realizedPnlUsd) ? s.realizedPnlUsd : 0),
      unrealizedPnlUsd:
        total.unrealizedPnlUsd + (isFiniteNumber(s.unrealizedPnlUsd) ? s.unrealizedPnlUsd : 0),
    }),
    {
      walletId: 'all',
      openPositions: 0,
      totalInvestedSol: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
    },
  );
}
