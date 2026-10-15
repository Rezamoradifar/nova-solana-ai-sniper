import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import publicNetworkRoutes from './publicNetwork.js';

async function setup() {
  const app = Fastify();
  app.decorate('config', { DEXSCREENER_API_BASE: 'https://source.example/' } as never);
  await app.register(publicNetworkRoutes);
  return app;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('public market feed', () => {
  it('shares slow upstream requests and expires snapshots without relabeling their age', async () => {
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let resolve!: (value: Response) => void;
    const upstream = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue(new Response('[{"priceUsd":"150"}]'));
    vi.stubGlobal('fetch', upstream);
    const app = await setup();
    try {
      const first = app.inject('/public/markets');
      const second = app.inject('/public/markets');
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
      resolve(new Response('[{"priceUsd":"149"}]'));
      const responses = await Promise.all([first, second]);
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(responses[0].headers['cache-control']).toBe('no-store');
      expect(responses[0].headers['x-market-updated-at']).toBe('100000');
      now += 1_000;
      expect((await app.inject('/public/markets')).headers['x-market-updated-at']).toBe('100000');
      expect(upstream).toHaveBeenCalledTimes(1);
      now += 1_001;
      expect((await app.inject('/public/markets')).json()).toEqual([{ priceUsd: '150' }]);
      expect(upstream).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
  it.each([
    [429, 'busy', 429],
    [500, 'error', 502],
    [200, '{}', 502],
    [200, '[]', 502],
  ])(
    'handles source %s / %s without a server error or request storm',
    async (status, body, expected) => {
      const upstream = vi.fn().mockResolvedValue(new Response(body, { status }));
      vi.stubGlobal('fetch', upstream);
      const app = await setup();
      try {
        const response = await app.inject('/public/markets');
        expect(response.statusCode).toBe(expected);
        expect(response.headers['x-market-updated-at']).toBeUndefined();
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
        expect((await app.inject('/public/markets')).statusCode).toBe(expected);
        expect(upstream).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    },
  );
  it('turns network timeouts into an unavailable response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const app = await setup();
    try {
      expect((await app.inject('/public/markets')).statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
});

it('exposes GMGN connection state without requiring a configured key', async () => {
  const app = await setup();
  try {
    const r = await app.inject('/public/gmgn/markets');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ source: 'GMGN', status: 'not_configured', tokens: [] });
  } finally {
    await app.close();
  }
});
