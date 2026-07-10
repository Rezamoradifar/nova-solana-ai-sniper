import type { FastifyInstance } from 'fastify';
import { PortfolioService } from '@nova/shared';

export default async function portfolioRoutes(fastify: FastifyInstance) {
  const portfolioService = new PortfolioService(fastify.prisma);

  fastify.get('/portfolio', { preHandler: fastify.authenticate }, async (req) => {
    const wallets = await fastify.prisma.wallet.findMany({
      where: { userId: req.user.userId },
    });
    const summaries = await Promise.all(
      wallets.map((w) => portfolioService.getSummary(w.id, new Map())),
    );
    return summaries;
  });

  fastify.get('/leaderboard', async () => portfolioService.getLeaderboard());
}
