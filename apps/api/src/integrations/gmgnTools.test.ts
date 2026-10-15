import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGmgnTools, gmgnToolArgs, gmgnToolSchema, unwrapGmgn } from './gmgnTools.js';
const address = 'So11111111111111111111111111111111111111112';
afterEach(() => vi.restoreAllMocks());
describe('GMGN web tool boundary', () => {
  it('exposes only read-only allowlisted operations', () => {
    for (const tool of ['swap', 'buy', 'sell', 'config', 'follow-wallet', 'arbitrary'])
      expect(gmgnToolSchema.safeParse({ tool }).success).toBe(false);
    for (const query of ['--help', 'x;cat /etc/passwd', '$(env)'])
      expect(gmgnToolSchema.safeParse({ tool: 'search', query }).success).toBe(false);
    expect(gmgnToolSchema.safeParse({ tool: 'pool', address: '--help' }).success).toBe(false);
  });
  it.each([
    'trending',
    'hot-searches',
    'trenches',
    'signal',
    'search',
    'kline',
    'token-info',
    'security',
    'pool',
    'holders',
    'traders',
    'holdings',
    'activity',
    'stats',
    'smartmoney',
    'kol',
  ])('builds fixed %s command arguments', (tool) => {
    const args = gmgnToolArgs(gmgnToolSchema.parse({ tool, address, query: 'SOL' }));
    expect(args.slice(-3)).toEqual(['--chain', 'sol', '--raw']);
    expect(['market', 'token', 'portfolio', 'track']).toContain(args[0]);
    expect(args).not.toContain('swap');
  });
  it('requires inputs and rejects error envelopes', () => {
    expect(() => gmgnToolArgs(gmgnToolSchema.parse({ tool: 'security' }))).toThrow();
    expect(() => gmgnToolArgs(gmgnToolSchema.parse({ tool: 'search' }))).toThrow();
    expect(unwrapGmgn({ code: 0, data: { list: [] } })).toEqual({ list: [] });
    expect(() => unwrapGmgn({ code: 403, data: { list: [] } })).toThrow();
  });
  it('deduplicates, limits concurrent operations, and bounds cooldown retries', async () => {
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let resolve!: (value: unknown) => void;
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockRejectedValue(new Error('secret-key'));
    const query = createGmgnTools(run);
    expect((await query({ tool: 'trending' })).status).toBe('not_configured');
    const a = query({ tool: 'trending' }, 'secret');
    const b = query({ tool: 'trending' }, 'secret');
    expect((await query({ tool: 'kol' }, 'secret')).status).toBe('busy');
    resolve({ rank: [] });
    await Promise.all([a, b]);
    expect(run).toHaveBeenCalledTimes(1);
    await query({ tool: 'trending' }, 'secret');
    expect(run).toHaveBeenCalledTimes(1);
    now += 31_000;
    const failed = await query({ tool: 'kol' }, 'secret');
    expect(failed.status).toBe('unavailable');
    expect(JSON.stringify(failed)).not.toContain('secret');
    expect((await query({ tool: 'smartmoney' }, 'secret')).status).toBe('cooldown');
    expect(run).toHaveBeenCalledTimes(2);
  });
});
