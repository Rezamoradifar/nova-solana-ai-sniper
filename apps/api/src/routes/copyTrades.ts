import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const createSchema = z.object({
  targetAddress: z.string().min(32).max(44),
  copyPercentSize: z.number().positive().max(100).default(100),
  maxAmountSol: z.number().positive().optional(),
});

export default async function copyTradeRoutes(fastify: FastifyInstance) {
  fastify.get('/copy-trades', { preHandler: fastify.authenticate }, async (req) => {
    return fastify.prisma.copyTradeConfig.findMany({ where: { userId: req.user.userId } });
  });

  fastify.post('/copy-trades', { preHandler: fastify.authenticate }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const config = await fastify.prisma.copyTradeConfig.create({
      data: { ...body, userId: req.user.userId },
    });
    return reply.code(201).send(config);
  });

  fastify.delete('/copy-trades/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const config = await fastify.prisma.copyTradeConfig.findUnique({ where: { id } });
    if (!config || config.userId !== req.user.userId) {
      return reply.code(404).send({ error: 'Copy trade config not found' });
    }
    await fastify.prisma.copyTradeConfig.delete({ where: { id } });
    return reply.code(204).send();
  });
}
