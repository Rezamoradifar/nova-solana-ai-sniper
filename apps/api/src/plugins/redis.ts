import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

export default fp(async (fastify: FastifyInstance) => {
  const redis = new Redis(fastify.config.REDIS_URL, { maxRetriesPerRequest: 3 });
  // ioredis emits 'error' on every connection failure, not just explicit calls;
  // with zero listeners that's an unhandled EventEmitter error, crashing the
  // whole API/worker process on a transient Redis blip.
  redis.on('error', (err) => fastify.log.error({ err }, 'redis client error'));
  fastify.decorate('redis', redis);
  fastify.addHook('onClose', async () => {
    redis.disconnect();
  });
});
