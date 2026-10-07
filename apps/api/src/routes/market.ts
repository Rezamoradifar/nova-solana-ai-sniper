import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActiveArbitrageScanner } from '../trading/arbitrageScanner.js';

const winnersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  days: z.coerce.number().int().min(1).max(30).default(7),
});

/**
 * User-facing trading intelligence. Everything here is derived from real
 * platform/network data; no synthetic profit claims are created.
 */
export default async function marketRoutes(fastify: FastifyInstance) {
  fastify.get('/market/network-winners', { preHandler: fastify.authenticate }, async (req) => {
    const { limit, days } = winnersQuery.parse(req.query);
    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await fastify.prisma.smartWalletTokenEntry.findMany({
      where: {
        status: 'EXITED',
        exitAt: { gte: since },
        realizedRoiPercent: { gt: 0 },
        realizedPnlUsd: { gt: 0 },
        entryAmountSol: { not: null },
        exitAmountSol: { not: null },
      },
      orderBy: [{ realizedRoiPercent: 'desc' }, { exitAt: 'desc' }],
      take: Math.min(limit * 3, 100),
      include: {
        token: { select: { name: true, symbol: true, dex: true, imageUrl: true } },
        wallet: {
          select: {
            confidenceScore: true,
            rugExposureRatePct: true,
            sybilConfidencePct: true,
          },
        },
      },
    });

    const internal = await fastify.prisma.wallet.findMany({
      where: { publicKey: { in: rows.map((r) => r.walletAddress) } },
      select: { publicKey: true },
    });
    const internalKeys = new Set(internal.map((w) => w.publicKey));

    return rows
      .filter(
        (r) =>
          !internalKeys.has(r.walletAddress) &&
          (r.wallet.rugExposureRatePct ?? 0) <= 50 &&
          (r.wallet.sybilConfidencePct ?? 0) <= 70,
      )
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        mint: r.mint,
        tokenName: r.token?.name ?? null,
        tokenSymbol: r.token?.symbol ?? null,
        dex: r.token?.dex ?? null,
        imageUrl: r.token?.imageUrl ?? null,
        walletAddress: r.walletAddress,
        walletConfidenceScore: r.wallet.confidenceScore ?? null,
        entryAt: r.entryAt,
        exitAt: r.exitAt,
        entrySignature: r.entrySignature,
        exitSignature: r.exitSignature,
        entryAmountSol: r.entryAmountSol,
        exitAmountSol: r.exitAmountSol,
        realizedRoiPercent: r.realizedRoiPercent,
        realizedPnlSol: r.realizedPnlSol,
        realizedPnlUsd: r.realizedPnlUsd,
      }));
  });

  fastify.get('/market/arbitrage', { preHandler: fastify.authenticate }, async () => {
    return getActiveArbitrageScanner()?.report() ?? {
      enabled: false,
      mode: 'paper',
      note: 'Arbitrage radar is disabled. It never executes trades from this endpoint.',
    };
  });
}
