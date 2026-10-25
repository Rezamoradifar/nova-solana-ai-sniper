import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import publicRoutes from './publicCopyTrading.js';
vi.mock('../trading/copyWalletRanking.js', () => ({
  loadRankedCopyWallets: vi.fn(async () => []),
  COPY_RECOMMENDATION_POLICY: {},
}));

interface Options {
  stops?: Array<string | null>;
  envKillSwitch?: boolean;
  scannerState?: string;
  workersReady?: boolean;
  redisDown?: boolean;
  redisStalled?: boolean;
}

async function read(
  mode: 'LIVE' | 'PAPER',
  running: boolean,
  healthy: boolean,
  options: Options = {},
) {
  const app = Fastify();
  app.decorate('prisma', {} as never);
  app.decorate('config', {
    COPY_TRADING_MAX_BUY_SOL: 0.1,
    COPY_TRADING_MAX_DAILY_BUYS: 10,
    COPY_TRADING_MAX_OPEN_POSITIONS: 3,
    COPY_TRADING_SLIPPAGE_BPS: 150,
    COPY_TRADING_EXECUTION_ENABLED: true,
    KILL_SWITCH: options.envKillSwitch ?? false,
  } as never);
  app.decorate('redis', {
    mget: () =>
      options.redisDown
        ? Promise.reject(new Error('private-redis-url'))
        : options.redisStalled
          ? new Promise(() => {})
          : Promise.resolve(options.stops ?? ['0', '0']),
  } as never);
  app.decorate('backgroundWorkersReady', options.workersReady ?? true);
  app.decorate('scannerHealthCoordinator', {
    snapshot: () => ({
      state: options.scannerState ?? 'HEALTHY',
      wsHealthy: true,
      fallbackHealthy: false,
    }),
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
      buyReadiness: { ready: false, blockers: ['PAPER_MODE'] },
    });
  });
  it('never describes a degraded but executing live worker as disabled', async () => {
    expect(await read('LIVE', true, false)).toMatchObject({
      executionMode: 'live',
      copyWatcherReady: false,
      liveExecutionEnabled: true,
      buyReadiness: { ready: false, blockers: ['COPY_WATCHER_UNHEALTHY'] },
    });
  });
  it('reports a stopped watcher as disabled', async () => {
    expect(await read('LIVE', false, false)).toMatchObject({
      executionMode: 'disabled',
      liveExecutionEnabled: false,
      buyReadiness: { ready: false, blockers: ['COPY_EXECUTION_DISABLED'] },
    });
  });

  it('reports fresh buy readiness independently of the nominal LIVE mode', async () => {
    const body = await read('LIVE', true, true);
    expect(body).toMatchObject({
      executionMode: 'live',
      liveExecutionEnabled: true,
      buyReadiness: { ready: true, blockers: [] },
    });
    expect(body.buyReadiness.checkedAt).toBeGreaterThan(0);
  });

  it('keeps LIVE mode visible while each safety stop blocks new-buy readiness', async () => {
    for (const options of [{ envKillSwitch: true }, { stops: ['1', '0'] }, { stops: ['0', '1'] }]) {
      expect(await read('LIVE', true, true, options)).toMatchObject({
        executionMode: 'live',
        liveExecutionEnabled: true,
        buyReadiness: { ready: false, blockers: ['BUYING_PAUSED'] },
      });
    }
  });

  it('does not treat a healthy watcher as proof of scanner or worker readiness', async () => {
    expect(await read('LIVE', true, true, { scannerState: 'UNHEALTHY' })).toMatchObject({
      buyReadiness: { ready: false, blockers: ['SCANNER_UNHEALTHY'] },
    });
    expect(await read('LIVE', true, true, { workersReady: false })).toMatchObject({
      buyReadiness: { ready: false, blockers: ['WORKERS_NOT_READY'] },
    });
  });

  it('does not advertise buys when safety state is unknown and never exposes Redis errors', async () => {
    for (const options of [{ redisDown: true }, { stops: ['unexpected-private-value', '0'] }]) {
      const body = await read('LIVE', true, true, options);
      expect(body.buyReadiness).toMatchObject({ ready: false, blockers: ['SAFETY_STATE_UNKNOWN'] });
      expect(JSON.stringify(body)).not.toContain('private');
    }
  });

  it('bounds the public request when Redis stops responding', async () => {
    expect(await read('LIVE', true, true, { redisStalled: true })).toMatchObject({
      buyReadiness: { ready: false, blockers: ['SAFETY_STATE_UNKNOWN'] },
    });
  });

  it('reuses the ranked-wallet query result for frequent public polls', async () => {
    const { loadRankedCopyWallets } = await import('../trading/copyWalletRanking.js');
    vi.mocked(loadRankedCopyWallets).mockClear();
    const app = Fastify();
    app.decorate('prisma', {} as never);
    app.decorate('config', {
      COPY_TRADING_MAX_BUY_SOL: 0.1,
      COPY_TRADING_MAX_DAILY_BUYS: 10,
      COPY_TRADING_MAX_OPEN_POSITIONS: 3,
      COPY_TRADING_SLIPPAGE_BPS: 150,
    } as never);
    app.decorate('tradingMode', 'PAPER' as never);
    await app.register(publicRoutes);
    try {
      await app.inject('/public/copy-trading');
      await app.inject('/public/copy-trading');
      expect(loadRankedCopyWallets).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it('exposes an explicitly unconfigured trader feed and rejects unsupported periods', async () => {
    const app = Fastify();
    app.decorate('config', {} as never);
    await app.register(publicRoutes);
    try {
      const response = await app.inject('/public/copy-trading/traders?period=7d');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({
        source: 'GMGN',
        chain: 'solana',
        period: '7d',
        scope: 'active_smart_money_sample',
        status: 'not_configured',
        traders: [],
        performanceUpdatedAt: null,
      });
      expect((await app.inject('/public/copy-trading/traders?period=1d')).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
