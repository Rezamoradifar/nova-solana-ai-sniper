import { buildApp } from './app.js';
import { startBackgroundWorkers } from './worker.js';

async function main() {
  const app = await buildApp();

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
