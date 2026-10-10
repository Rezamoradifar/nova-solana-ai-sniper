import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIntegrationHealth } from './integrationHealth.js';
import type { ApiEnv } from '../config/env.js';
afterEach(() => vi.unstubAllGlobals());
const config = {
  HELIUS_API_KEY: 'SECRET-key',
  TELEGRAM_BOT_TOKEN: 'SECRET-token',
  OPENAI_API_KEY: 'SECRET-ai',
} as ApiEnv;

describe('connection diagnostics', () => {
  it('distinguishes provider errors without exposing keys, URLs, bodies or raw errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('helius')) return new Response('SECRET-provider-error', { status: 403 });
        if (url.includes('telegram')) throw new Error('SECRET-token in URL');
        return Response.json({ error: { code: 429, message: 'SECRET-url' } });
      }),
    );
    const result = await createIntegrationHealth(config)();
    expect(result.find((r) => r.key === 'helius')?.status).toBe('access_denied');
    expect(result.find((r) => r.key === 'public')?.status).toBe('rate_limited');
    expect(result.find((r) => r.key === 'telegram')?.status).toBe('unavailable');
    expect(result.find((r) => r.key === 'openai')?.status).toBe('unchecked');
    expect(result.find((r) => r.key === 'gmgn')?.status).toBe('not_configured');
    expect(JSON.stringify(result)).not.toMatch(/SECRET|https?:/);
  });
  it('deduplicates concurrent requests and caches checks for one minute', async () => {
    const fetcher = vi.fn(async () => Response.json({ result: 123 }));
    vi.stubGlobal('fetch', fetcher);
    const check = createIntegrationHealth({} as ApiEnv);
    const [a, b] = await Promise.all([check(), check()]);
    await check();
    expect(a).toEqual(b);
    expect(a[0]?.status).toBe('healthy');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not accept a 200 with a malformed JSON-RPC payload as healthy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: 'not a slot' })),
    );
    expect((await createIntegrationHealth({} as ApiEnv)())[0]?.status).toBe('unavailable');
  });
});
