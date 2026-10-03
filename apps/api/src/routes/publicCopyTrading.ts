import type { FastifyInstance } from 'fastify';
import { fetchGmgnSmartMoney } from '../integrations/gmgn.js';

export function publicWalletScore(wallet: {
  confidenceScore: number | null;
  sybilConfidencePct: number | null;
  rugExposureRatePct: number | null;
}): number {
  const confidence = Math.max(0, Math.min(100, wallet.confidenceScore ?? 0));
  const sybilPenalty = Math.max(0, Math.min(100, wallet.sybilConfidencePct ?? 0));
  const rugPenalty = Math.max(0, Math.min(100, wallet.rugExposureRatePct ?? 0));
  return Math.max(0, Math.round(confidence * (1 - sybilPenalty / 100) * (1 - rugPenalty / 100)));
}

export default async function publicCopyTradingRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/public/copy-trading',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');

      const wallets = await fastify.prisma.smartWallet.findMany({
        where: { isTracked: true },
        orderBy: [{ confidenceScore: 'desc' }, { lastActivityAt: 'desc' }],
        take: 50,
        select: {
          address: true,
          label: true,
          confidenceScore: true,
          sampleSize: true,
          medianRoiPercent: true,
          avgRoiPercent: true,
          earlyEntryRatePct: true,
          rugExposureRatePct: true,
          realizedPnlUsd: true,
          unrealizedPnlUsd: true,
          lastActivityAt: true,
          sybilConfidencePct: true,
        },
      });

      const localWallets = wallets
        .map((wallet) => ({ ...wallet, signalScore: publicWalletScore(wallet) }))
        .sort((a, b) => b.signalScore - a.signalScore);

      const gmgnApiKey = process.env.GMGN_API_KEY?.trim();
      let gmgn:
        | { status: 'not_configured'; trades: [] }
        | { status: 'connected'; trades: Awaited<ReturnType<typeof fetchGmgnSmartMoney>> }
        | { status: 'unavailable'; trades: []; reason: string };

      if (!gmgnApiKey) {
        gmgn = { status: 'not_configured', trades: [] };
      } else {
        try {
          gmgn = { status: 'connected', trades: await fetchGmgnSmartMoney(gmgnApiKey, 50) };
        } catch (error) {
          gmgn = {
            status: 'unavailable',
            trades: [],
            reason: error instanceof Error ? error.message : 'GMGN data unavailable',
          };
        }
      }

      return {
        chain: 'solana',
        mode: 'signal_only',
        copyConfigEnabled: true,
        liveExecutionEnabled: false,
        updatedAt: Date.now(),
        localWallets,
        gmgn,
      };
    },
  );
}
