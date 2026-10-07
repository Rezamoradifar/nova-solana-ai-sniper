import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { userId: string; role: 'ADMIN' | 'TRADER' };
  }
}

export default fp(async (fastify: FastifyInstance) => {
  await fastify.register(fastifyJwt, {
    secret: fastify.config.JWT_SECRET,
    sign: { expiresIn: '7d' },
  });

  fastify.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const account = await fastify.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { isSuspended: true, deletedAt: true },
    });
    if (!account || account.deletedAt) {
      await reply.code(401).send({ error: 'Account unavailable' });
      return;
    }
    if (account.isSuspended) {
      await reply.code(403).send({ error: 'Account suspended by administrator' });
    }
  });

  fastify.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const account = await fastify.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true, isSuspended: true, deletedAt: true },
    });
    if (!account || account.deletedAt || account.isSuspended || account.role !== 'ADMIN') {
      await reply.code(403).send({ error: 'Forbidden' });
    }
  });
});
