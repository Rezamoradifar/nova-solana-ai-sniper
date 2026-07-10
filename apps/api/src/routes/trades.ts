import type { FastifyInstance } from 'fastify';

export default async function tradeRoutes(fastify: FastifyInstance) {
  fastify.get('/trades', { preHandler: fastify.authenticate }, async (req) => {
    const wallets = await fastify.prisma.wallet.findMany({
      where: { userId: req.user.userId },
      select: { id: true },
    });
    return fastify.prisma.trade.findMany({
      where: { walletId: { in: wallets.map((w) => w.id) } },
      include: { token: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });
}
