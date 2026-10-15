import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import gmgnToolsRoutes from './gmgnTools.js';
describe('GMGN research API', () => {
  it('rejects arbitrary commands and missing inputs before accessing GMGN', async () => {
    const app = Fastify();
    const run = vi.fn();
    app.decorate('config', { GMGN_API_KEY: 'test' } as never);
    await app.register(gmgnToolsRoutes, { run });
    try {
      for (const payload of [
        { tool: 'swap' },
        { tool: 'kline' },
        { tool: 'security', address: '--help' },
        { tool: 'search', query: '--help' },
        { tool: 'trending', command: 'buy' },
      ]) {
        expect(
          (await app.inject({ method: 'POST', url: '/public/gmgn/tools', payload })).statusCode,
        ).toBe(400);
      }
      expect(run).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('routes on-demand research to the server runner without exposing the key', async () => {
    const app = Fastify();
    const run = vi.fn().mockResolvedValue({ list: [{ symbol: 'SOL', price: 150 }] });
    app.decorate('config', { GMGN_API_KEY: 'server-key' } as never);
    await app.register(gmgnToolsRoutes, { run });
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/public/gmgn/tools',
        payload: { tool: 'smartmoney' },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        status: 'connected',
        tool: 'smartmoney',
        data: { list: [{ symbol: 'SOL', price: 150 }] },
      });
      expect(run).toHaveBeenCalledWith(
        ['track', 'smartmoney', '--limit', '20', '--chain', 'sol', '--raw'],
        'server-key',
      );
      expect(r.body).not.toContain('server-key');
      expect(r.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });
});
