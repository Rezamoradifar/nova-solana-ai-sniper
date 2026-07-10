import { describe, expect, it, vi } from 'vitest';
import { MigrationMonitor, mapDexIdToDex } from './migrationMonitor.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

describe('mapDexIdToDex', () => {
  it('maps known DexScreener dexId strings to the Dex enum', () => {
    expect(mapDexIdToDex('pumpfun')).toBe('PUMPFUN');
    expect(mapDexIdToDex('pumpswap')).toBe('PUMPSWAP');
    expect(mapDexIdToDex('raydium')).toBe('RAYDIUM');
    expect(mapDexIdToDex('meteora')).toBe('METEORA');
    expect(mapDexIdToDex('jupiter')).toBe('JUPITER');
  });

  it('is case-insensitive and matches Raydium/Orca/Meteora sub-variants by prefix', () => {
    expect(mapDexIdToDex('Raydium')).toBe('RAYDIUM');
    expect(mapDexIdToDex('raydium-clmm')).toBe('RAYDIUM');
    expect(mapDexIdToDex('orca-whirlpool')).toBe('ORCA');
    expect(mapDexIdToDex('meteora-dlmm')).toBe('METEORA');
  });

  it('returns undefined instead of guessing on an unrecognized or absent dexId', () => {
    expect(mapDexIdToDex('some-new-dex')).toBeUndefined();
    expect(mapDexIdToDex(undefined)).toBeUndefined();
  });
});

vi.mock('../solana/pumpfunBondingCurve.js', () => ({
  getBondingCurveState: vi.fn(),
}));

import { getBondingCurveState } from '../solana/pumpfunBondingCurve.js';

describe('MigrationMonitor.checkOne', () => {
  it('does nothing when the bonding curve is not complete', async () => {
    vi.mocked(getBondingCurveState).mockResolvedValueOnce({
      virtualTokenReserves: 0n,
      virtualSolReserves: 0n,
      realTokenReserves: 0n,
      realSolReserves: 0n,
      tokenTotalSupply: 0n,
      complete: false,
    });
    const update = vi.fn();
    const monitor = new MigrationMonitor({
      prisma: { token: { update } } as never,
      connection: {} as never,
      dexScreener: { getBestSolanaPair: vi.fn() } as never,
      logger: fakeLogger(),
    });

    const result = await monitor.checkOne('token-1', 'MintAAAA');
    expect(result).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('does nothing when the bonding curve cannot be read at all (transient failure, not proof of migration)', async () => {
    vi.mocked(getBondingCurveState).mockResolvedValueOnce(undefined);
    const update = vi.fn();
    const monitor = new MigrationMonitor({
      prisma: { token: { update } } as never,
      connection: {} as never,
      dexScreener: { getBestSolanaPair: vi.fn() } as never,
      logger: fakeLogger(),
    });

    expect(await monitor.checkOne('token-1', 'MintAAAA')).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('records a migration and notifies when complete and the new venue resolves', async () => {
    vi.mocked(getBondingCurveState).mockResolvedValueOnce({
      virtualTokenReserves: 0n,
      virtualSolReserves: 0n,
      realTokenReserves: 0n,
      realSolReserves: 0n,
      tokenTotalSupply: 0n,
      complete: true,
    });
    const update = vi.fn().mockResolvedValue({ id: 'token-1', symbol: 'FOO' });
    const notifyMigration = vi.fn();
    const monitor = new MigrationMonitor({
      prisma: { token: { update } } as never,
      connection: {} as never,
      dexScreener: {
        getBestSolanaPair: vi
          .fn()
          .mockResolvedValue({ dexId: 'raydium', pairAddress: 'PoolAddr111' }),
      } as never,
      logger: fakeLogger(),
      notifier: { notifyMigration } as never,
    });

    const result = await monitor.checkOne('token-1', 'MintAAAA');
    expect(result).toBe(true);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'token-1' },
      data: { dex: 'RAYDIUM', poolAddress: 'PoolAddr111' },
    });
    expect(notifyMigration).toHaveBeenCalledWith({
      mint: 'MintAAAA',
      symbol: 'FOO',
      fromDex: 'PUMPFUN',
      toDex: 'RAYDIUM',
    });
  });

  it('does not update when complete but the new venue cannot be confidently resolved', async () => {
    vi.mocked(getBondingCurveState).mockResolvedValueOnce({
      virtualTokenReserves: 0n,
      virtualSolReserves: 0n,
      realTokenReserves: 0n,
      realSolReserves: 0n,
      tokenTotalSupply: 0n,
      complete: true,
    });
    const update = vi.fn();
    const monitor = new MigrationMonitor({
      prisma: { token: { update } } as never,
      connection: {} as never,
      dexScreener: { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never,
      logger: fakeLogger(),
    });

    expect(await monitor.checkOne('token-1', 'MintAAAA')).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('MigrationMonitor.tick', () => {
  it('checks every candidate token and swallows a single failure without aborting the batch', async () => {
    vi.mocked(getBondingCurveState)
      .mockRejectedValueOnce(new Error('rpc blip'))
      .mockResolvedValueOnce({
        virtualTokenReserves: 0n,
        virtualSolReserves: 0n,
        realTokenReserves: 0n,
        realSolReserves: 0n,
        tokenTotalSupply: 0n,
        complete: false,
      });

    const findMany = vi.fn().mockResolvedValue([
      { id: 't1', mint: 'MintA' },
      { id: 't2', mint: 'MintB' },
    ]);
    const monitor = new MigrationMonitor({
      prisma: { token: { findMany, update: vi.fn() } } as never,
      connection: {} as never,
      dexScreener: { getBestSolanaPair: vi.fn() } as never,
      logger: fakeLogger(),
    });

    await expect(monitor.tick()).resolves.toBeUndefined();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ dex: 'PUMPFUN' }) }),
    );
  });

  it('ignores overlapping ticks while one is already in flight', async () => {
    let resolveFindMany: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      resolveFindMany = resolve;
    });
    const findMany = vi.fn().mockImplementation(async () => {
      await inFlight;
      return [];
    });
    const monitor = new MigrationMonitor({
      prisma: { token: { findMany, update: vi.fn() } } as never,
      connection: {} as never,
      dexScreener: { getBestSolanaPair: vi.fn() } as never,
      logger: fakeLogger(),
    });

    const first = monitor.tick();
    const second = monitor.tick();
    resolveFindMany?.();
    await Promise.all([first, second]);

    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
