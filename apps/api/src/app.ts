import Fastify, { type FastifyError } from 'fastify';
import { ZodError } from 'zod';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import configPlugin from './plugins/config.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import tokenRoutes from './routes/tokens.js';
import tradeRoutes from './routes/trades.js';
import positionRoutes from './routes/positions.js';
import snipeRoutes from './routes/snipes.js';
import portfolioRoutes from './routes/portfolio.js';
import walletRoutes from './routes/wallets.js';

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(configPlugin);
  await app.register(helmet);
  await app.register(cors, { origin: app.config.CORS_ORIGIN, credentials: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(tokenRoutes);
  await app.register(tradeRoutes);
  await app.register(positionRoutes);
  await app.register(snipeRoutes);
  await app.register(portfolioRoutes);
  await app.register(walletRoutes);

  app.setErrorHandler((err: FastifyError | ZodError, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Validation failed', details: err.issues });
    }
    if (err.validation) {
      return reply.code(400).send({ error: 'Validation failed', details: err.validation });
    }
    app.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: 'Internal server error' });
  });

  return app;
}
