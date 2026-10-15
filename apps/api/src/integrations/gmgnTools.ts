import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { z } from 'zod';
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
export const gmgnToolSchema = z
  .object({
    tool: z.enum([
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
    ]),
    address: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
      .optional(),
    query: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._@-]*$/u)
      .optional(),
    interval: z.enum(['1m', '5m', '1h', '6h', '24h']).default('1h'),
    resolution: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).default('5m'),
  })
  .strict();
export type GmgnToolInput = z.infer<typeof gmgnToolSchema>;
export function gmgnToolArgs(input: GmgnToolInput, now = Date.now()) {
  const { tool, address, query, interval, resolution } = input;
  if (
    [
      'kline',
      'token-info',
      'security',
      'pool',
      'holders',
      'traders',
      'holdings',
      'activity',
      'stats',
    ].includes(tool) &&
    !address
  )
    throw new Error('A Solana address is required');
  let args: string[];
  if (tool === 'search') {
    if (!query) throw new Error('A search term is required');
    args = ['market', 'search', '--query', query];
  } else if (tool === 'kline') {
    const to = Math.floor(now / 60_000) * 60;
    args = [
      'market',
      'kline',
      '--address',
      address!,
      '--resolution',
      resolution,
      '--from',
      String(to - 86_400),
      '--to',
      String(to),
    ];
  } else if (['token-info', 'security', 'pool', 'holders', 'traders'].includes(tool)) {
    args = ['token', tool === 'token-info' ? 'info' : tool, '--address', address!];
    if (tool === 'holders' || tool === 'traders') args.push('--limit', '20');
  } else if (['holdings', 'activity', 'stats'].includes(tool)) {
    args = ['portfolio', tool, '--wallet', address!];
    if (tool === 'stats') args.push('--period', '7d');
    else args.push('--limit', '20');
  } else if (tool === 'smartmoney' || tool === 'kol') {
    args = ['track', tool, '--limit', '20'];
  } else {
    args = ['market', tool];
    if (tool === 'trending' || tool === 'hot-searches') args.push('--interval', interval);
    if (tool === 'trending') args.push('--order-by', 'volume', '--limit', '20');
    if (tool === 'trenches') args.push('--type', 'new_creation');
  }
  return [...args, '--chain', 'sol', '--raw'];
}
export function unwrapGmgn(input: unknown): unknown {
  if (!input || typeof input !== 'object') throw new Error('Invalid GMGN response');
  if ('code' in input) return z.object({ code: z.literal(0), data: z.unknown() }).parse(input).data;
  return input;
}
export async function runGmgnTool(args: string[], apiKey: string): Promise<unknown> {
  const { stdout } = await exec(process.execPath, [require.resolve('gmgn-cli'), ...args], {
    timeout: 10_000,
    maxBuffer: 1_048_576,
    env: { PATH: process.env.PATH, GMGN_API_KEY: apiKey, NODE_ENV: 'production' },
  });
  return unwrapGmgn(JSON.parse(stdout));
}
export function createGmgnTools(run = runGmgnTool) {
  const cache = new Map<string, { data: unknown; updatedAt: number }>();
  const pending = new Map<string, Promise<{ data: unknown; updatedAt: number }>>();
  let retryAt = 0;
  let lastStartedAt = -Infinity;
  return async (raw: unknown, apiKey?: string) => {
    const input = gmgnToolSchema.parse(raw);
    const args = gmgnToolArgs(input);
    const base = { tool: input.tool, source: 'GMGN', chain: 'sol' };
    if (!apiKey?.trim()) return { ...base, status: 'not_configured', data: null, updatedAt: null };
    const key = JSON.stringify(args);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.updatedAt < 30_000)
      return { ...base, status: 'connected', ...cached };
    if (Date.now() < retryAt) return { ...base, status: 'cooldown', data: null, retryAt };
    let request = pending.get(key);
    if (!request) {
      // One process at a time, at most one new query every 2s across all visitors.
      if (pending.size || Date.now() - lastStartedAt < 2_000)
        return { ...base, status: 'busy', data: null };
      lastStartedAt = Date.now();
      request = run(args, apiKey.trim())
        .then((data) => {
          const value = { data, updatedAt: Date.now() };
          if (cache.size >= 64) cache.delete(cache.keys().next().value!);
          cache.set(key, value);
          return value;
        })
        .finally(() => {
          pending.delete(key);
        });
      pending.set(key, request);
    }
    try {
      return { ...base, status: 'connected', ...(await request) };
    } catch {
      retryAt = Date.now() + 300_000;
      return { ...base, status: 'unavailable', data: null, retryAt };
    }
  };
}
