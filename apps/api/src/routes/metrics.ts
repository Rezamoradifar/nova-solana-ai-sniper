import type { FastifyInstance } from 'fastify';
import { metrics } from '../lib/metrics.js';

export default async function metricsRoutes(fastify: FastifyInstance) {
  fastify.get('/metrics', async () => metrics.snapshot());
}
