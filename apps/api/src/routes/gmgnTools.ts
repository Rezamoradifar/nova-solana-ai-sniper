import type { FastifyInstance } from 'fastify';
import {
  createGmgnTools,
  gmgnToolArgs,
  gmgnToolSchema,
  runGmgnTool,
} from '../integrations/gmgnTools.js';
export default async function gmgnToolsRoutes(
  app: FastifyInstance,
  options: { run?: typeof runGmgnTool } = {},
) {
  const query = createGmgnTools(options.run);
  app.post(
    '/public/gmgn/tools',
    { bodyLimit: 2048, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const input = gmgnToolSchema.safeParse(req.body);
      if (!input.success)
        return reply.code(400).send({ error: 'Choose a supported tool and valid inputs.' });
      try {
        gmgnToolArgs(input.data);
      } catch {
        return reply.code(400).send({ error: 'Enter the required Solana address or search term.' });
      }
      return query(input.data, app.config.GMGN_API_KEY);
    },
  );
}
