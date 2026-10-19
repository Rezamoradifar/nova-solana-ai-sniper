import type { FastifyInstance } from 'fastify';
import { createCopyLeaderboard } from '../trading/copyLeaderboardFeed.js';
/** Read-only directory. No configuration writes, trading flags, wallet keys or order submission. */
export default async function realCopyDirectory(app: FastifyInstance) {
  const feed = createCopyLeaderboard(app.prisma, () => app.config.GMGN_API_KEY);
  app.addHook('onReady', async () => { feed.start(); });
  app.addHook('onClose', async () => { feed.stop(); });
  app.get('/public/copy-leaderboard', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const snapshot = await feed.read();
    const watcher = app.copyTradeWatcher?.getStatus();
    return { ...snapshot,
      execution: { mode: !watcher?.running ? 'disabled' : app.tradingMode === 'LIVE' ? 'live' : 'paper',
        watcherHealthy: watcher?.healthy === true, directoryReadOnly: true, activationPerformed: false },
      limits: { maxBuySol: app.config.COPY_TRADING_MAX_BUY_SOL,
        maxDailyBuys: app.config.COPY_TRADING_MAX_DAILY_BUYS, maxOpenPositions: app.config.COPY_TRADING_MAX_OPEN_POSITIONS,
        slippageBps: app.config.COPY_TRADING_SLIPPAGE_BPS } };
  });
}
