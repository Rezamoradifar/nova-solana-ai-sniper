import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { reserveWorkerRuntime, installWorkerLifecycle } from './workerLifecycle.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('HTTP and worker lifecycle', () => {
  it('serves HTTP during startup and shares runtime assignments with registered routes', async () => {
    const app = Fastify();
    reserveWorkerRuntime(app);
    const boot = deferred<() => Promise<void>>();
    const cleanup = vi.fn(async () => {});
    const start = installWorkerLifecycle(app, () => boot.promise);
    await app.register(async (routes) => {
      routes.get('/runtime', async () => ({
        ready: routes.backgroundWorkersReady,
        mode: routes.tradingMode ?? null,
      }));
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      start();
      start();
      expect((await app.inject('/runtime')).json()).toEqual({ ready: false, mode: null });
      app.tradingMode = 'PAPER';
      boot.resolve(cleanup);
      await vi.waitFor(() => expect(app.backgroundWorkersReady).toBe(true));
      expect((await app.inject('/runtime')).json()).toEqual({ ready: true, mode: 'PAPER' });
    } finally {
      await app.close();
    }
    expect(app.backgroundWorkersReady).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('waits for startup cleanup when shutdown arrives during initialization', async () => {
    const app = Fastify();
    reserveWorkerRuntime(app);
    const boot = deferred<() => Promise<void>>();
    const cleanup = vi.fn(async () => {});
    const start = installWorkerLifecycle(app, () => boot.promise);
    await app.ready();
    start();
    const closing = app.close();
    boot.resolve(cleanup);
    await closing;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(app.backgroundWorkersReady).toBe(false);
  });
  it('keeps the HTTP service available after worker startup rejects', async () => {
    const app = Fastify();
    reserveWorkerRuntime(app);
    const start = installWorkerLifecycle(app, async () => {
      throw new Error('RPC unavailable');
    });
    app.get('/health', async () => ({ ok: true }));
    await app.ready();
    start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.backgroundWorkersReady).toBe(false);
    expect((await app.inject('/health')).statusCode).toBe(200);
    await app.close();
  });
});
