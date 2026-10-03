import type { FastifyInstance } from 'fastify';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

const solanaAddress = z
  .string()
  .min(32)
  .max(44)
  .refine((value) => {
    try {
      new PublicKey(value);
      return true;
    } catch {
      return false;
    }
  }, 'targetAddress must be a valid Solana public key');

const createSchema = z.object({
  targetAddress: solanaAddress,
  copyPercentSize: z.number().positive().max(100).default(25),
  maxAmountSol: z.number().positive().max(100).default(0.1),
});

const patchSchema = z.object({
  isActive: z.boolean().optional(),
  copyPercentSize: z.number().positive().max(100).optional(),
  maxAmountSol: z.number().positive().max(100).nullable().optional(),
});

export default async function copyTradeRoutes(fastify: FastifyInstance) {
  fastify.get('/copy-trades', { preHandler: fastify.authenticate }, async (req) => {
    return fastify.prisma.copyTradeConfig.findMany({
      where: { userId: req.user.userId },
      orderBy: { createdAt: 'desc' },
    });
  });

  fastify.post('/copy-trades', { preHandler: fastify.authenticate }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const existing = await fastify.prisma.copyTradeConfig.findFirst({
      where: { userId: req.user.userId, targetAddress: body.targetAddress },
    });
    if (existing) {
      const updated = await fastify.prisma.copyTradeConfig.update({
        where: { id: existing.id },
        data: {
          isActive: true,
          copyPercentSize: body.copyPercentSize,
          maxAmountSol: body.maxAmountSol,
        },
      });
      return reply.code(200).send(updated);
    }
    const config = await fastify.prisma.copyTradeConfig.create({
      data: { ...body, userId: req.user.userId },
    });
    return reply.code(201).send(config);
  });

  fastify.patch('/copy-trades/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);
    const config = await fastify.prisma.copyTradeConfig.findUnique({ where: { id } });
    if (!config || config.userId !== req.user.userId) {
      return reply.code(404).send({ error: 'Copy trade config not found' });
    }
    return fastify.prisma.copyTradeConfig.update({ where: { id }, data: body });
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
