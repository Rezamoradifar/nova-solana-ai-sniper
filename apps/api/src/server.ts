import { buildApp } from './app.js';
import { startBackgroundWorkers } from './worker.js';
import { applyAdminFeatureOverrides } from './lib/adminFeatureOverrides.js';
import { installWorkerLifecycle } from './lib/workerLifecycle.js';

async function main() {
  const app = await buildApp();

  // Feature choices made in the Admin Control Center are persisted in the DB
  // and applied before startup-sensitive workers/services are constructed.
  await applyAdminFeatureOverrides(app.prisma, app.config, app.log as never);

  const startWorkers = installWorkerLifecycle(app, () => startBackgroundWorkers(app));

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.backgroundWorkersReady = false;
    app.log.info('shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await app.listen({ port: app.config.API_PORT, host: app.config.API_HOST });
  startWorkers();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
