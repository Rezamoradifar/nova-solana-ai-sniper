import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { loadApiEnv, type ApiEnv } from '../config/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: ApiEnv;
  }
}

export default fp(async (fastify: FastifyInstance) => {
  const config = loadApiEnv();
  fastify.decorate('config', config);
});
