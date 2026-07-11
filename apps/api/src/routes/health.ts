import type { FastifyInstance } from 'fastify';

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  fastify.get('/health/ready', async (_req, reply) => {
    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
      await fastify.redis.ping();
      // Optional: only present once background workers have actually started
      // (see worker.ts) — an RPC outage previously wasn't visible here at all.
      if (fastify.solanaConnection) {
        await fastify.solanaConnection.getSlot();
      }
      return { status: 'ready' };
    } catch (err) {
      fastify.log.error(err, 'readiness check failed');
      return reply.code(503).send({ status: 'not_ready' });
    }
  });
}
