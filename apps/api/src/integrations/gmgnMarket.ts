import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { z } from 'zod';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const numeric = z
  .union([z.number(), z.string().min(1)])
  .transform(Number)
  .pipe(z.number().finite());
const tokenSchema = z.object({
  address: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  symbol: z.string().max(80),
  name: z.string().max(200),
  price: numeric.pipe(z.number().positive()),
  volume: numeric.pipe(z.number().nonnegative()).optional(),
  liquidity: numeric.pipe(z.number().nonnegative()).optional(),
  smart_degen_count: numeric.pipe(z.number().int().nonnegative()).optional(),
});
export function normalizeGmgnTrending(input: unknown) {
  const response = z.object({ rank: z.array(z.unknown()).max(100) }).parse(input);
  return response.rank
    .flatMap((row) => {
      const token = tokenSchema.safeParse(row);
      if (!token.success) return [];
      const t = token.data;
      return [
        {
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          priceUsd: t.price,
          volumeUsd: t.volume ?? null,
          liquidityUsd: t.liquidity ?? null,
          smartMoneyHolders: t.smart_degen_count ?? null,
        },
      ];
    })
    .slice(0, 20);
}

async function runTrending(apiKey: string): Promise<unknown> {
  // Fixed read-only CLI arguments, no shell or user-controlled executable/flags.
  const { stdout } = await exec(
    process.execPath,
    [
      require.resolve('gmgn-cli'),
      'market',
      'trending',
      '--chain',
      'sol',
      '--interval',
      '1h',
      '--order-by',
      'volume',
      '--limit',
      '20',
      '--raw',
    ],
    {
      timeout: 10_000,
      maxBuffer: 1_048_576,
      env: { PATH: process.env.PATH, GMGN_API_KEY: apiKey, NODE_ENV: 'production' },
    },
  );
  return JSON.parse(stdout);
}

type Snapshot = { tokens: ReturnType<typeof normalizeGmgnTrending>; updatedAt: number };
export function createGmgnMarketFeed(run = runTrending) {
  let snapshot: Snapshot | undefined;
  let pending: Promise<Snapshot> | undefined;
  let retryAt = 0;
  return async (apiKey?: string) => {
    const base = { source: 'GMGN', chain: 'sol', interval: '1h', refreshMs: 15_000 };
    if (!apiKey?.trim()) return { ...base, status: 'not_configured', tokens: [], updatedAt: null };
    try {
      if (!snapshot || Date.now() - snapshot.updatedAt >= 15_000) {
        if (Date.now() < retryAt) throw new Error('Source cooldown');
        if (!pending)
          pending = run(apiKey.trim())
            .then((data) => {
              snapshot = { tokens: normalizeGmgnTrending(data), updatedAt: Date.now() };
              return snapshot;
            })
            .catch(() => {
              // Conservative cooldown prevents extending provider bans across public viewers.
              retryAt = Date.now() + 300_000;
              throw new Error('GMGN unavailable');
            })
            .finally(() => {
              pending = undefined;
            });
        await pending;
      }
      return { ...base, status: 'connected', ...snapshot! };
    } catch {
      // Never serialize CLI stderr, credential details or raw upstream payloads.
      return {
        ...base,
        status: 'unavailable',
        tokens: snapshot?.tokens ?? [],
        updatedAt: snapshot?.updatedAt ?? null,
        retryAt,
      };
    }
  };
}
