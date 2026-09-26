import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import healthRoutes from './health.js';

describe('service readiness', () => {
  async function probe(workers: boolean, rpc: boolean, fail?: 'db' | 'redis' | 'rpc') {
    const app = Fastify();
    app.decorate('backgroundWorkersReady', workers);
    app.decorate('prisma', {
      $queryRaw: vi.fn(async () => {
        if (fail === 'db') throw new Error('unavailable');
        return [1];
      }),
    } as never);
    app.decorate('redis', {
      ping: vi.fn(async () => {
        if (fail === 'redis') throw new Error('unavailable');
        return 'PONG';
      }),
    } as never);
    if (rpc)
      app.decorate('solanaConnection', {
        getSlot: vi.fn(async () => {
          if (fail === 'rpc') throw new Error('unavailable');
          return 1;
        }),
      } as never);
    await app.register(healthRoutes);
    try {
      const live = await app.inject('/health');
      const ready = await app.inject('/health/ready');
      return { live: live.statusCode, ready: ready.statusCode };
    } finally {
      await app.close();
    }
  }
  it('keeps liveness separate from failed worker startup', async () => {
    expect(await probe(false, true)).toEqual({ live: 200, ready: 503 });
  });
  it('requires an RPC connection', async () => {
    expect((await probe(true, false)).ready).toBe(503);
  });
  it.each(['db', 'redis', 'rpc'] as const)('rejects failed %s dependency', async (failure) => {
    expect((await probe(true, true, failure)).ready).toBe(503);
  });
  it('accepts a started worker with healthy dependencies', async () => {
    expect((await probe(true, true)).ready).toBe(200);
  });
});
