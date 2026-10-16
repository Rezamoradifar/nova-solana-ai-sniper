import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import routes from './integrations.js';
afterEach(() => vi.unstubAllGlobals());
async function fixture(role: string, suspended = false, signedIn = true) {
  const app = Fastify();
  app.decorate('config', {} as never);
  app.decorate('prisma', {
    user: {
      findUnique: async () => ({ role, telegramId: null, isSuspended: suspended, deletedAt: null }),
    },
  } as never);
  app.decorateRequest('jwtVerify', async function (this: any) {
    if (!signedIn) throw new Error('unsigned');
    this.user = { userId: 'u1' };
  });
  await app.register(routes);
  return app;
}
describe('admin connection diagnostic access', () => {
  it.each([
    ['TRADER', false, true, 403],
    ['ADMIN', true, true, 403],
    ['ADMIN', false, false, 401],
  ] as const)(
    'rejects role=%s suspended=%s signedIn=%s before making network requests',
    async (role, suspended, signedIn, status) => {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      const app = await fixture(role, suspended, signedIn);
      try {
        expect((await app.inject('/admin/integrations')).statusCode).toBe(status);
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it('returns checked status to an administrator without caching the HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: 1 })),
    );
    const app = await fixture('ADMIN');
    try {
      const response = await app.inject('/admin/integrations');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });
});
