import type { FastifyInstance } from 'fastify';

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  fastify.get('/health/ready', async (_req, reply) => {
    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
      await fastify.redis.ping();
      return { status: 'ready' };
    } catch (err) {
      fastify.log.error(err, 'readiness check failed');
      return reply.code(503).send({ status: 'not_ready' });
    }
  });
}
