import type { FastifyInstance } from 'fastify';

// Fastify disallows new decorators after listen(). Reserve the shared slots
// before routes are registered; workers fill them while HTTP is already up.
export function reserveWorkerRuntime(app: FastifyInstance) {
  app.decorate('backgroundWorkersReady', false);
  for (const name of [
    'solanaConnection',
    'positionManager',
    'dexScreener',
    'sourceHealthMonitor',
    'pumpFunMonitor',
    'fallbackLaunchDiscovery',
    'scannerHealthCoordinator',
    'scannerConcurrencyGovernor',
    'tradingMode',
    'copyTradingExecutionReady',
    'copyTradeWatcher',
  ])
    app.decorate(name, undefined);
}

export function installWorkerLifecycle(
  app: FastifyInstance,
  start: () => Promise<() => Promise<void> | void>,
) {
  let closing = false;
  let task: Promise<void> | undefined;
  let stop: (() => Promise<void> | void) | undefined;
  app.addHook('onClose', async () => {
    closing = true;
    app.backgroundWorkersReady = false;
    await task;
    await stop?.();
  });
  return () => {
    if (task || closing) return;
    task = Promise.resolve()
      .then(start)
      .then((cleanup) => {
        stop = cleanup;
        if (!closing) app.backgroundWorkersReady = true;
      })
      .catch((err: unknown) => {
        app.backgroundWorkersReady = false;
        app.log.error({ err }, 'worker startup failed; HTTP remains available for recovery');
      });
  };
}
