import Fastify, { type FastifyError } from 'fastify';
import { ZodError } from 'zod';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import configPlugin from './plugins/config.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import healthRoutes from './routes/health.js';
import metricsRoutes from './routes/metrics.js';
import authRoutes from './routes/auth.js';
import tokenRoutes from './routes/tokens.js';
import tradeRoutes from './routes/trades.js';
import positionRoutes from './routes/positions.js';
import snipeRoutes from './routes/snipes.js';
import portfolioRoutes from './routes/portfolio.js';
import analyticsRoutes from './routes/analytics.js';
import walletRoutes from './routes/wallets.js';
import referralRoutes from './routes/referrals.js';
import adminRoutes from './routes/admin.js';
import copyTradeRoutes from './routes/copyTrades.js';
import wsRoutes from './routes/ws.js';
import { registerFeeSystem } from './business/registerFeeSystem.js';

export async function buildApp() {
  // trustProxy: the API only ever receives real client traffic via the Nginx
  // reverse proxy (docker-compose), which sets X-Forwarded-For — without this,
  // rate limiting would key off Nginx's own IP and apply to all users at once.
  //
  // logger.level: `logger: true` alone defaults Fastify's internal pino instance
  // to 'info' regardless of the LOG_LEVEL env var — every logger.debug(...) call
  // anywhere in this app (worker.ts, positionManager.ts, autoTrader.ts all log via
  // this same app.log instance) was silently unreachable no matter how LOG_LEVEL
  // was set. Read directly from process.env here (not the config plugin, which
  // isn't registered yet) — matches the same process.env.LOG_LEVEL read
  // packages/shared's own createLogger() already does.
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
  });

  await app.register(configPlugin);
  await app.register(helmet);
  await app.register(cors, { origin: app.config.CORS_ORIGIN, credentials: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(websocket);

  await app.register(healthRoutes);
  await app.register(metricsRoutes);
  await app.register(authRoutes);
  await app.register(tokenRoutes);
  await app.register(tradeRoutes);
  await app.register(positionRoutes);
  await app.register(snipeRoutes);
  await app.register(portfolioRoutes);
  await app.register(analyticsRoutes);
  await app.register(walletRoutes);
  await app.register(referralRoutes);
  await app.register(adminRoutes);
  await app.register(copyTradeRoutes);
  await app.register(wsRoutes);

  // Fee/referral system — a pure event-bus subscriber reacting to the already-
  // existing 'position.updated' event after a position has already closed.
  // Does not touch trading/execution code (positionManager.ts, autoTrader.ts,
  // riskAnalyzer.ts, worker.ts) at all — see registerFeeSystem.ts's own doc comment.
  registerFeeSystem({ prisma: app.prisma, log: app.log as never, config: app.config });

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
