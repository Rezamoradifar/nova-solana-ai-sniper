import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const updateSchema = z.object({
  takeProfitPercent: z.number().positive().optional(),
  stopLossPercent: z.number().positive().optional(),
  trailingStopPercent: z.number().positive().optional(),
});

export default async function positionRoutes(fastify: FastifyInstance) {
  fastify.get('/positions', { preHandler: fastify.authenticate }, async (req) => {
    const wallets = await fastify.prisma.wallet.findMany({
      where: { userId: req.user.userId },
      select: { id: true },
    });
    return fastify.prisma.position.findMany({
      where: { walletId: { in: wallets.map((w) => w.id) } },
      include: { token: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  fastify.patch('/positions/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateSchema.parse(req.body);

    const position = await fastify.prisma.position.findUnique({
      where: { id },
      include: { wallet: true },
    });
    if (!position || position.wallet.userId !== req.user.userId) {
      return reply.code(404).send({ error: 'Position not found' });
    }

    return fastify.prisma.position.update({ where: { id }, data: body });
  });
}
