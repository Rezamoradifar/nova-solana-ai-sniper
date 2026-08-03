import { describe, expect, it, vi } from 'vitest';
import { buildLivePriceMap } from './portfolio.js';

function fakeFastify(
  openPositions: { token: { mint: string } }[],
  prices: Record<string, number | undefined>,
) {
  return {
    prisma: {
      position: {
        findMany: vi.fn().mockResolvedValue(openPositions),
      },
    },
    dexScreener: {
      getBestSolanaPair: vi.fn().mockImplementation(async (mint: string) => {
        const priceUsd = prices[mint];
        return priceUsd === undefined ? undefined : { priceUsd: String(priceUsd) };
      }),
    },
  };
}

describe('buildLivePriceMap', () => {
  it('regression: returns a populated map, not the always-empty Map() every call site used to pass — the exact bug that made unrealizedPnlUsd always compute to 0', async () => {
    const fastify = fakeFastify([{ token: { mint: 'MINT_A' } }], { MINT_A: 1.5 });
    const map = await buildLivePriceMap(fastify as never, ['wallet-1']);
    expect(map.get('MINT_A')).toBe(1.5);
  });

  it('dedupes repeated mints across multiple positions into one DexScreener call', async () => {
    const fastify = fakeFastify(
      [{ token: { mint: 'MINT_A' } }, { token: { mint: 'MINT_A' } }, { token: { mint: 'MINT_B' } }],
      { MINT_A: 2, MINT_B: 3 },
    );
    await buildLivePriceMap(fastify as never, ['wallet-1']);
    expect(fastify.dexScreener.getBestSolanaPair).toHaveBeenCalledTimes(2);
  });

  it('omits a mint from the map rather than inserting a fabricated price when DexScreener has none', async () => {
    const fastify = fakeFastify([{ token: { mint: 'MINT_A' } }], { MINT_A: undefined });
    const map = await buildLivePriceMap(fastify as never, ['wallet-1']);
    expect(map.has('MINT_A')).toBe(false);
  });

  it('returns an empty map without querying when dexScreener is not decorated (engine not started)', async () => {
    const fastify = { prisma: { position: { findMany: vi.fn() } } } as never;
    const map = await buildLivePriceMap(fastify as never, ['wallet-1']);
    expect(map.size).toBe(0);
  });

  it('returns an empty map without querying when there are no wallets', async () => {
    const fastify = fakeFastify([], {});
    const map = await buildLivePriceMap(fastify as never, []);
    expect(map.size).toBe(0);
    expect(fastify.prisma.position.findMany).not.toHaveBeenCalled();
  });
});
