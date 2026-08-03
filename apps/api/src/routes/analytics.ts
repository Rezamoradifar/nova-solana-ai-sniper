import type { FastifyInstance } from 'fastify';
import { summarizePerformance, type TradeOutcome } from '../trading/backtestMetrics.js';
import { buildAiLearningReport } from '../trading/aiLearningMetrics.js';

/**
 * Phase 7b-d analytics (2026-07-29) — real-data-only, same convention as the
 * rest of this codebase's reporting surfaces: every figure below is computed
 * from this user's own real, closed, non-paper positions, never fabricated
 * or estimated from a market-wide sample.
 *
 * costBasisUsd = amountToken * entryPriceUsd exactly matches how
 * realizedPnlUsd was itself computed at close time (see positionManager.ts),
 * and stays correct across partial exits because Position.amountToken always
 * means "the amount originally bought" (see schema.prisma's own comment on
 * that field) — so this is the position's full original USD cost basis, not
 * an approximation.
 */
export function toTradeOutcome(position: {
  realizedPnlUsd: number | null;
  amountToken: number;
  entryPriceUsd: number;
}): TradeOutcome & { costBasisUsd: number } {
  const costBasisUsd = position.amountToken * position.entryPriceUsd;
  const pnlAmount = position.realizedPnlUsd ?? 0;
  const pnlPercent = costBasisUsd > 0 ? (pnlAmount / costBasisUsd) * 100 : 0;
  return { pnlPercent, pnlAmount, costBasisUsd };
}

export default async function analyticsRoutes(fastify: FastifyInstance) {
  fastify.get('/analytics/performance', { preHandler: fastify.authenticate }, async (req) => {
    const wallets = await fastify.prisma.wallet.findMany({
      where: { userId: req.user.userId },
      select: { id: true },
    });

    const positions = await fastify.prisma.position.findMany({
      where: {
        walletId: { in: wallets.map((w) => w.id) },
        status: 'CLOSED',
        isPaperTrade: false,
        realizedPnlUsd: { not: null },
      },
      select: {
        realizedPnlUsd: true,
        amountToken: true,
        entryPriceUsd: true,
        riskScoreAtEntry: true,
        exitReason: true,
        closedAt: true,
      },
      orderBy: { closedAt: 'asc' },
    });

    const outcomes = positions.map(toTradeOutcome);
    const totalInvested = outcomes.reduce((sum, o) => sum + o.costBasisUsd, 0);
    const performance = summarizePerformance(outcomes, totalInvested);

    const aiLearning = buildAiLearningReport(
      positions.map((p, i) => ({
        scoreAtEntry: p.riskScoreAtEntry,
        pnlPercent: outcomes[i]!.pnlPercent,
      })),
      positions.map((p, i) => ({ exitReason: p.exitReason, pnlPercent: outcomes[i]!.pnlPercent })),
    );

    return {
      totalPositionsAnalyzed: positions.length,
      performance,
      aiLearning,
    };
  });
}
