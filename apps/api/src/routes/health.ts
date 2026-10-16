import type { FastifyInstance } from 'fastify';
import { withDeadline } from '../lib/deadline.js';

declare module 'fastify' {
  interface FastifyInstance {
    backgroundWorkersReady: boolean;
  }
}

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  fastify.get('/health/ready', async (_req, reply) => {
    if (!fastify.backgroundWorkersReady || !fastify.solanaConnection) {
      return reply.code(503).send({
        status: 'not_ready',
        reason: !fastify.backgroundWorkersReady
          ? 'background workers are not ready'
          : 'no RPC connection',
      });
    }
    try {
      await withDeadline(
        Promise.all([
          fastify.prisma.$queryRaw`SELECT 1`,
          fastify.redis.ping(),
          fastify.solanaConnection.getSlot(),
        ]),
        4000,
      );
      return { status: 'ready' };
    } catch (err) {
      fastify.log.error(err, 'readiness check failed');
      return reply.code(503).send({ status: 'not_ready' });
    }
  });
}
