import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { isValidSolanaPublicKey } from '@nova/shared';
import { z } from 'zod';

export const createCopySchema = z.object({
  targetAddress: z.string().trim().refine(isValidSolanaPublicKey, 'Invalid Solana wallet address'),
  copyPercentSize: z.number().finite().positive().max(100).default(25),
  maxAmountSol: z.number().finite().positive().max(10).default(0.1),
});

export async function isInternalCopyTarget(prisma: Pick<PrismaClient, 'wallet'>, address: string) {
  return Boolean(
    await prisma.wallet.findFirst({ where: { publicKey: address }, select: { id: true } }),
  );
}

export default async function copyTradeRoutes(fastify: FastifyInstance) {
  const guard = { preHandler: fastify.authenticate };
  fastify.get('/copy-trades', guard, async (req) => {
    return fastify.prisma.copyTradeConfig.findMany({ where: { userId: req.user.userId } });
  });

  async function accountReady(userId: string) {
    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
      select: {
        isSuspended: true,
        deletedAt: true,
        wallets: { where: { isActive: true }, select: { id: true }, take: 1 },
      },
    });
    return user && !user.isSuspended && !user.deletedAt && user.wallets.length > 0;
  }

  const createConfig =
    (isActive: boolean): RouteHandlerMethod =>
    async (req, reply) => {
      const parsed = createCopySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
      const body = parsed.data;
      if (!(await accountReady(req.user.userId))) {
        return reply.code(409).send({ error: 'An active account and trading wallet are required' });
      }
      if (await isInternalCopyTarget(fastify.prisma, body.targetAddress))
        return reply.code(400).send({ error: 'Internal GSP wallets cannot be copy targets' });
      const existing = await fastify.prisma.copyTradeConfig.findFirst({
        where: { userId: req.user.userId, targetAddress: body.targetAddress },
      });
      if (existing)
        return reply.code(409).send({ error: 'Wallet already configured; use Resume if paused' });
      const config = await fastify.prisma.copyTradeConfig.create({
        data: {
          ...body,
          maxAmountSol: Math.min(body.maxAmountSol, fastify.config.COPY_TRADING_MAX_BUY_SOL),
          userId: req.user.userId,
          isActive,
        },
      });
      return reply.code(201).send(config);
    };
  fastify.post('/copy-trades', guard, createConfig(true));
  // A distinct endpoint fails closed against an older API during a rollback;
  // an ignored JSON property must never turn a paused setup into an active one.
  fastify.post('/copy-trades/drafts', guard, createConfig(false));

  fastify.put('/copy-trades/:id/status', guard, async (req, reply) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'enabled must be boolean' });
    const { id } = req.params as { id: string };
    const config = await fastify.prisma.copyTradeConfig.findUnique({ where: { id } });
    if (!config || config.userId !== req.user.userId)
      return reply.code(404).send({ error: 'Copy trade config not found' });
    if (parsed.data.enabled && !(await accountReady(req.user.userId))) {
      return reply.code(409).send({ error: 'An active account and trading wallet are required' });
    }
    return fastify.prisma.copyTradeConfig.update({
      where: { id },
      data: { isActive: parsed.data.enabled },
    });
  });

  fastify.delete('/copy-trades/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const config = await fastify.prisma.copyTradeConfig.findUnique({ where: { id } });
    if (!config || config.userId !== req.user.userId)
      return reply.code(404).send({ error: 'Copy trade config not found' });
    await fastify.prisma.copyTradeConfig.delete({ where: { id } });
    return reply.code(204).send();
  });
}
