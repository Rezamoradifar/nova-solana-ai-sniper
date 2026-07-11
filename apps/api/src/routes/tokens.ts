import type { FastifyInstance } from 'fastify';
import { Dex } from '@prisma/client';
import { z } from 'zod';

// Derived from the real Prisma Dex enum (not a hand-copied literal list) so this
// filter can never drift out of sync again — it was previously missing PUMPSWAP
// and METEORA, silently 400ing valid `/tokens?dex=PUMPSWAP` requests. A new DEX
// added to schema.prisma's Dex enum is automatically accepted here too.
export const listQuerySchema = z.object({
  dex: z.nativeEnum(Dex).optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

export default async function tokenRoutes(fastify: FastifyInstance) {
  fastify.get('/tokens', async (req) => {
    const query = listQuerySchema.parse(req.query);
    return fastify.prisma.token.findMany({
      where: query.dex ? { dex: query.dex } : undefined,
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
  });

  fastify.get('/tokens/:mint', async (req, reply) => {
    const { mint } = req.params as { mint: string };
    const token = await fastify.prisma.token.findUnique({ where: { mint } });
    if (!token) return reply.code(404).send({ error: 'Token not found' });
    return token;
  });
}
