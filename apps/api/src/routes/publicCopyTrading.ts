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

      const gmgnApiKey = fastify.config.GMGN_API_KEY?.trim();
      let gmgn:
        | { status: 'not_configured'; trades: []; wallets: [] }
        | {
            status: 'connected';
            trades: Awaited<ReturnType<typeof fetchGmgnSmartMoney>>;
            wallets: Array<{
              address: string;
              trades: number;
              volumeUsd: number;
              buys: number;
              sells: number;
              tags: string[];
            }>;
          }
        | { status: 'unavailable'; trades: []; wallets: []; reason: string };

      if (!gmgnApiKey) {
        gmgn = { status: 'not_configured', trades: [], wallets: [] };
      } else {
        try {
          const trades = await fetchGmgnSmartMoney(gmgnApiKey, 50);
          const byMaker = new Map<
            string,
            {
              address: string;
              trades: number;
              volumeUsd: number;
              buys: number;
              sells: number;
              tags: Set<string>;
            }
          >();
          for (const trade of trades) {
            const current = byMaker.get(trade.maker) ?? {
              address: trade.maker,
              trades: 0,
              volumeUsd: 0,
              buys: 0,
              sells: 0,
              tags: new Set<string>(),
            };
            current.trades += 1;
            current.volumeUsd += trade.amountUsd ?? 0;
            if (trade.side === 'buy') current.buys += 1;
            if (trade.side === 'sell') current.sells += 1;
            for (const tag of trade.tags) current.tags.add(tag);
            byMaker.set(trade.maker, current);
          }
          const wallets = [...byMaker.values()]
            .map((wallet) => ({ ...wallet, tags: [...wallet.tags].slice(0, 8) }))
            .sort((a, b) => b.volumeUsd - a.volumeUsd || b.trades - a.trades)
            .slice(0, 30);
          gmgn = { status: 'connected', trades, wallets };
        } catch (error) {
          gmgn = {
            status: 'unavailable',
            trades: [],
            wallets: [],
            reason: error instanceof Error ? error.message : 'GMGN data unavailable',
          };
        }
      }

      return {
        chain: 'solana',
        mode: 'signal_only',
        copyConfigEnabled: true,
        liveExecutionEnabled: fastify.tradingMode === 'LIVE',
        updatedAt: Date.now(),
        localWallets,
        gmgn,
      };
    },
  );
}
