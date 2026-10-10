import type { FastifyInstance } from 'fastify';
import { requireAdminUser } from '../lib/adminAccess.js';
import { createIntegrationHealth } from '../lib/integrationHealth.js';

export default async function integrationRoutes(app: FastifyInstance) {
  const check = createIntegrationHealth(app.config);
  app.get(
    '/admin/integrations',
    {
      preHandler: requireAdminUser,
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    },
    async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      return {
        integrations: await check(),
        cacheSeconds: 60,
        note: 'Read-only HTTP checks. WebSocket subscriptions, trade execution and model inference are not verified here.',
      };
    },
  );
}
