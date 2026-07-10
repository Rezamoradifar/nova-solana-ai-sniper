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
  fastify.decorate('redis', redis);
  fastify.addHook('onClose', async () => {
    redis.disconnect();
  });
});
