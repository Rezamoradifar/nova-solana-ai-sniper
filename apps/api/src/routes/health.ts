import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    backgroundWorkersReady: boolean;
  }
}

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  fastify.get('/health/ready', async (_req, reply) => {
    if (!fastify.backgroundWorkersReady || !fastify.solanaConnection) {
      return reply.code(503).send({ status: 'not_ready' });
    }
    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
      await fastify.redis.ping();
      await fastify.solanaConnection.getSlot();
      return { status: 'ready' };
    } catch (err) {
      fastify.log.error(err, 'readiness check failed');
      return reply.code(503).send({ status: 'not_ready' });
    }
  });
}
