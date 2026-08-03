import { describe, it, expect, vi } from 'vitest';
import {
  computeDueOffsets,
  isLikelyRugFromSample,
  PRICE_SAMPLE_OFFSETS,
  ShadowModePriceSampler,
} from './shadowModePriceSampler.js';
import type { DexScreenerPair } from '../solana/dexscreener.js';

describe('computeDueOffsets', () => {
  it('returns no offsets when nothing has elapsed yet', () => {
    const detectedAt = new Date();
    expect(computeDueOffsets(detectedAt, detectedAt.getTime(), new Set())).toEqual([]);
  });

  it('returns every offset whose time has passed, catching up after a gap', () => {
    const detectedAt = new Date(0);
    const now = 2 * 60 * 60 * 1000; // 2 hours later — 5m/15m/1h all due
    const due = computeDueOffsets(detectedAt, now, new Set());
    expect(due.map((o) => o.field)).toEqual(['price5mUsd', 'price15mUsd', 'price1hUsd']);
  });

  it('excludes offsets already filled', () => {
    const detectedAt = new Date(0);
    const now = 2 * 60 * 60 * 1000;
    const due = computeDueOffsets(detectedAt, now, new Set(['price5mUsd', 'price15mUsd']));
    expect(due.map((o) => o.field)).toEqual(['price1hUsd']);
  });

  it('returns every configured offset once a full 24h has elapsed', () => {
    const detectedAt = new Date(0);
    const now = 25 * 60 * 60 * 1000;
    const due = computeDueOffsets(detectedAt, now, new Set());
    expect(due.length).toBe(PRICE_SAMPLE_OFFSETS.length);
  });
});

function pair(overrides: Partial<DexScreenerPair> = {}): DexScreenerPair {
  return {
    chainId: 'solana',
    dexId: 'pumpfun',
    pairAddress: 'p1',
    baseToken: { address: 'mint1', name: 'Test', symbol: 'TST' },
    quoteToken: { address: 'sol', name: 'SOL', symbol: 'SOL' },
    ...overrides,
  };
}

describe('isLikelyRugFromSample', () => {
  it('treats a vanished pair (no DexScreener listing) as a likely rug', () => {
    expect(isLikelyRugFromSample(undefined)).toBe(true);
  });

  it('treats collapsed liquidity as a likely rug', () => {
    expect(isLikelyRugFromSample(pair({ liquidity: { usd: 10 } }))).toBe(true);
  });

  it('does not flag healthy liquidity', () => {
    expect(isLikelyRugFromSample(pair({ liquidity: { usd: 50_000 } }))).toBe(false);
  });
});

describe('ShadowModePriceSampler', () => {
  it('fills due offsets and closes the row out once the 24h sample lands', async () => {
    const detectedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const row = {
      id: 'log1',
      mint: 'mint1',
      detectedAt,
      price5mUsd: null,
      price15mUsd: null,
      price1hUsd: null,
      price4hUsd: null,
      price24hUsd: null,
    };
    const findMany = vi.fn().mockResolvedValue([row]);
    const update = vi.fn().mockResolvedValue(undefined);
    const walletFindMany = vi.fn().mockResolvedValue([]);
    const walletUpdate = vi.fn();

    const getBestSolanaPair = vi
      .fn()
      .mockResolvedValue(pair({ priceUsd: '1.5', liquidity: { usd: 50_000 } }));

    const sampler = new ShadowModePriceSampler({
      prisma: {
        shadowModeDecisionLog: { findMany, update },
        smartWalletTokenEntry: { findMany: walletFindMany, update: walletUpdate },
      } as never,
      dexScreener: { getBestSolanaPair } as never,
      smartWalletTracker: { checkAndRecordExit: vi.fn().mockResolvedValue(false) } as never,
      logger: { debug: vi.fn() } as never,
    });

    await sampler.tick();

    expect(update).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0]![0].data;
    expect(data.price5mUsd).toBe(1.5);
    expect(data.price24hUsd).toBe(1.5);
    expect(data.sampledAt24h).toBeInstanceOf(Date);
  });

  it('marks a wallet entry RUG_FLAGGED when the sampled pair looks like a rug', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const update = vi.fn();
    const walletRow = {
      id: 'entry1',
      mint: 'mint1',
      walletAddress: 'wallet1',
      entryAt: new Date(),
      entryPriceUsd: 1.0,
      isRugOrScam: false,
    };
    const walletFindMany = vi.fn().mockResolvedValue([walletRow]);
    const walletUpdate = vi.fn().mockResolvedValue(undefined);
    const getBestSolanaPair = vi.fn().mockResolvedValue(undefined);

    const sampler = new ShadowModePriceSampler({
      prisma: {
        shadowModeDecisionLog: { findMany, update },
        smartWalletTokenEntry: { findMany: walletFindMany, update: walletUpdate },
      } as never,
      dexScreener: { getBestSolanaPair } as never,
      smartWalletTracker: { checkAndRecordExit: vi.fn().mockResolvedValue(false) } as never,
      logger: { debug: vi.fn() } as never,
    });

    await sampler.tick();

    expect(walletUpdate).toHaveBeenCalledTimes(1);
    const data = walletUpdate.mock.calls[0]![0].data;
    expect(data.status).toBe('RUG_FLAGGED');
    expect(data.isRugOrScam).toBe(true);
  });

  it('tries real exit-detection first and skips the price-based fallback when it finds one', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const update = vi.fn();
    const walletRow = {
      id: 'entry1',
      mint: 'mint1',
      walletAddress: 'wallet1',
      entryAt: new Date(),
      entryPriceUsd: 1.0,
      entryAmountSol: 1,
      isRugOrScam: false,
    };
    const walletFindMany = vi.fn().mockResolvedValue([walletRow]);
    const walletUpdate = vi.fn();
    const getBestSolanaPair = vi.fn();
    const checkAndRecordExit = vi.fn().mockResolvedValue(true);

    const sampler = new ShadowModePriceSampler({
      prisma: {
        shadowModeDecisionLog: { findMany, update },
        smartWalletTokenEntry: { findMany: walletFindMany, update: walletUpdate },
      } as never,
      dexScreener: { getBestSolanaPair } as never,
      smartWalletTracker: { checkAndRecordExit } as never,
      logger: { debug: vi.fn() } as never,
    });

    await sampler.tick();

    expect(checkAndRecordExit).toHaveBeenCalledWith({
      id: 'entry1',
      mint: 'mint1',
      walletAddress: 'wallet1',
      entryAt: walletRow.entryAt,
      entryAmountSol: 1,
    });
    // A real exit was recorded (by checkAndRecordExit itself) — this class's
    // own price-based RUG_FLAGGED/EXPIRED/OPEN update must never overwrite it.
    expect(getBestSolanaPair).not.toHaveBeenCalled();
    expect(walletUpdate).not.toHaveBeenCalled();
  });
});
