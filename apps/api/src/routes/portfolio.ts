import type { FastifyInstance } from 'fastify';
import { PortfolioService } from '@nova/shared';

/** Fetches one live price per distinct open-position mint (deduped,
 * parallelized) so PortfolioService.getSummary's unrealizedPnlUsd is real —
 * every call site of getSummary across this codebase (this route, and the
 * Telegram bot's dashboard.ts/portfolio.ts screens) has passed an empty
 * Map() since the original scaffold commit, which silently made
 * unrealizedPnlUsd always compute to exactly 0 (getSummary falls back to
 * entryPriceUsd when a mint isn't in the map, so currentPrice - entryPrice
 * is always 0). Pure reporting math, not a trading-logic change — the swap/
 * exit engine reads its own live prices independently via PriceMonitor. */
export async function buildLivePriceMap(
  fastify: FastifyInstance,
  walletIds: string[],
): Promise<Map<string, number>> {
  const livePrices = new Map<string, number>();
  if (!fastify.dexScreener || walletIds.length === 0) return livePrices;

  const openPositions = await fastify.prisma.position.findMany({
    where: { walletId: { in: walletIds }, status: 'OPEN' },
    include: { token: true },
  });
  const mints = [...new Set(openPositions.map((p) => p.token.mint))];

  await Promise.all(
    mints.map(async (mint) => {
      const pair = await fastify.dexScreener!.getBestSolanaPair(mint).catch(() => undefined);
      const price = pair?.priceUsd ? Number(pair.priceUsd) : undefined;
      if (price !== undefined && Number.isFinite(price)) livePrices.set(mint, price);
    }),
  );

  return livePrices;
}

export default async function portfolioRoutes(fastify: FastifyInstance) {
  const portfolioService = new PortfolioService(fastify.prisma);

  fastify.get('/portfolio', { preHandler: fastify.authenticate }, async (req) => {
    const wallets = await fastify.prisma.wallet.findMany({
      where: { userId: req.user.userId },
    });
    const livePrices = await buildLivePriceMap(
      fastify,
      wallets.map((w) => w.id),
    );
    const summaries = await Promise.all(
      wallets.map((w) => portfolioService.getSummary(w.id, livePrices)),
    );
    return summaries;
  });

  fastify.get('/leaderboard', async () => portfolioService.getLeaderboard());
}
