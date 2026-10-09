import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import publicRoutes from './publicCopyTrading.js';
vi.mock('../trading/copyWalletRanking.js', () => ({
  loadRankedCopyWallets: async () => [],
  COPY_RECOMMENDATION_POLICY: {},
}));

async function read(mode: 'LIVE' | 'PAPER', running: boolean, healthy: boolean) {
  const app = Fastify();
  app.decorate('prisma', {} as never);
  app.decorate('config', {
    COPY_TRADING_MAX_BUY_SOL: 0.1,
    COPY_TRADING_MAX_DAILY_BUYS: 10,
    COPY_TRADING_MAX_OPEN_POSITIONS: 3,
    COPY_TRADING_SLIPPAGE_BPS: 150,
  } as never);
  app.decorate('tradingMode', mode);
  app.decorate('copyTradeWatcher', {
    getStatus: () => ({ running, healthy, lastSuccessAt: null, lastErrorAt: null }),
  } as never);
  await app.register(publicRoutes);
  try {
    const r = await app.inject('/public/copy-trading');
    expect(r.statusCode).toBe(200);
    return r.json();
  } finally {
    await app.close();
  }
}
describe('public copy runtime status', () => {
  it('reports paper mode independently of a configured LIVE flag elsewhere', async () => {
    expect(await read('PAPER', true, true)).toMatchObject({
      executionMode: 'paper',
      liveExecutionEnabled: false,
      recommendations: [],
    });
  });
  it('never describes a degraded but executing live worker as disabled', async () => {
    expect(await read('LIVE', true, false)).toMatchObject({
      executionMode: 'live',
      copyWatcherReady: false,
      liveExecutionEnabled: true,
    });
  });
  it('reports a stopped watcher as disabled', async () => {
    expect(await read('LIVE', false, false)).toMatchObject({
      executionMode: 'disabled',
      liveExecutionEnabled: false,
    });
  });
});
