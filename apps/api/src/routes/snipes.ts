import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_SNIPE_CONFIGS_PER_USER } from '@nova/shared';

const createSchema = z.object({
  tokenId: z.string().optional(),
  buyAmountSol: z.number().positive(),
  maxSlippageBps: z.number().min(1).max(10000).default(300),
  minLiquidityUsd: z.number().min(0).default(1000),
  minAiScore: z.number().min(0).max(100).default(60),
  takeProfitPercent: z.number().positive().optional(),
  stopLossPercent: z.number().positive().optional(),
  trailingStopPercent: z.number().positive().optional(),
  autoBuyOnLaunch: z.boolean().default(false),
});

// Same shape as routes/positions.ts's updateSchema — this SnipeConfig was
// previously create-only (no edit path anywhere: not the Telegram bot's
// sniper.ts screen, not the dashboard). PositionManager only ever reads these
// three off SnipeConfig at buy time to seed a new position's own frozen
// takeProfitPercent/stopLossPercent/trailingStopPercent — editing a config
// never retroactively changes an already-open position.
const updateSchema = z.object({
  takeProfitPercent: z.number().positive().optional(),
  stopLossPercent: z.number().positive().optional(),
  trailingStopPercent: z.number().positive().optional(),
});

export default async function snipeRoutes(fastify: FastifyInstance) {
  fastify.get('/snipes', { preHandler: fastify.authenticate }, async (req) => {
    return fastify.prisma.snipeConfig.findMany({ where: { userId: req.user.userId } });
  });

  fastify.post('/snipes', { preHandler: fastify.authenticate }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const existingCount = await fastify.prisma.snipeConfig.count({
      where: { userId: req.user.userId },
    });
    if (existingCount >= MAX_SNIPE_CONFIGS_PER_USER) {
      return reply
        .code(409)
        .send({ error: `Maximum of ${MAX_SNIPE_CONFIGS_PER_USER} snipe configs per user` });
    }
    const config = await fastify.prisma.snipeConfig.create({
      data: { ...body, userId: req.user.userId },
    });
    return reply.code(201).send(config);
  });

  fastify.patch('/snipes/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateSchema.parse(req.body);
    const config = await fastify.prisma.snipeConfig.findUnique({ where: { id } });
    if (!config || config.userId !== req.user.userId) {
      return reply.code(404).send({ error: 'Snipe config not found' });
    }
    const updated = await fastify.prisma.snipeConfig.update({ where: { id }, data: body });
    return reply.send(updated);
  });

  fastify.delete('/snipes/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const config = await fastify.prisma.snipeConfig.findUnique({ where: { id } });
    if (!config || config.userId !== req.user.userId) {
      return reply.code(404).send({ error: 'Snipe config not found' });
    }
    await fastify.prisma.snipeConfig.delete({ where: { id } });
    return reply.code(204).send();
  });
}
