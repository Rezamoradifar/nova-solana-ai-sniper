import { buildApp } from './app.js';
import { startBackgroundWorkers } from './worker.js';
import { applyAdminFeatureOverrides } from './lib/adminFeatureOverrides.js';

async function main() {
  const app = await buildApp();

  // Feature choices made in the Admin Control Center are persisted in the DB
  // and applied before startup-sensitive workers/services are constructed.
  await applyAdminFeatureOverrides(app.prisma, app.config, app.log as never);

  const stopWorkers = await startBackgroundWorkers(app).catch((err) => {
    app.log.warn({ err }, 'background workers not started (likely missing optional config)');
    return undefined;
  });

  app.backgroundWorkersReady = Boolean(stopWorkers);

  await app.listen({ port: app.config.API_PORT, host: app.config.API_HOST });

  const shutdown = async () => {
    app.backgroundWorkersReady = false;
    app.log.info('shutting down');
    await stopWorkers?.();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
