import { describe, it, expect, vi } from 'vitest';
import { NetworkTradeScannerService } from './networkTradeScanner.js';

function makeRedis(claimResult: string | null = 'OK') {
  return { set: vi.fn().mockResolvedValue(claimResult) };
}

describe('NetworkTradeScannerService', () => {
  it('rotates past cooldown-skipped pages and wraps for later rescans', async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce([{ id: 't1', mint: 'mint1' }, { id: 't2', mint: 'mint2' }])
      .mockResolvedValueOnce([{ id: 't3', mint: 'mint3' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const evaluateForToken = vi.fn().mockResolvedValue(undefined);
    const redis = { set: vi.fn()
      .mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce('OK') };
    const scanner = new NetworkTradeScannerService({
      prisma: { token: { findMany } } as never,
      dexScreener: { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never,
      smartWalletTracker: { evaluateForToken } as never,
      redis: redis as never,
      logger: { debug: vi.fn(), error: vi.fn() } as never,
      batchSize: 1, minLiquidityUsd: 2_000, tokenLookbackHours: 48,
    });
    await scanner.tick();
    await scanner.tick();
    await scanner.tick();
    await scanner.tick();
    expect(evaluateForToken).toHaveBeenCalledWith('mint3', 't3', undefined, undefined);
    expect(findMany.mock.calls[1]![0].where.id).toEqual({ gt: 't2' });
    expect(findMany.mock.calls[2]![0].where.id).toEqual({ gt: 't3' });
    expect(findMany.mock.calls[3]![0].where.id).toBeUndefined();
  });

  it('resumes after the last processed mint when the batch ends mid-page', async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce([{ id: 't1', mint: 'mint1' }, { id: 't2', mint: 'mint2' }])
      .mockResolvedValueOnce([{ id: 't2', mint: 'mint2' }]);
    const evaluateForToken = vi.fn().mockResolvedValue(undefined);
    const scanner = new NetworkTradeScannerService({
      prisma: { token: { findMany } } as never,
      dexScreener: { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never,
      smartWalletTracker: { evaluateForToken } as never,
      redis: makeRedis() as never,
      logger: { debug: vi.fn(), error: vi.fn() } as never,
      batchSize: 1, minLiquidityUsd: 2_000, tokenLookbackHours: 48,
    });
    await scanner.tick();
    await scanner.tick();
    expect(findMany.mock.calls[1]![0].where.id).toEqual({ gt: 't1' });
    expect(evaluateForToken).toHaveBeenCalledTimes(2);
  });

  it('queries tokens across every DEX (no dex filter) within the lookback window', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const scanner = new NetworkTradeScannerService({
      prisma: { token: { findMany } } as never,
      dexScreener: { getBestSolanaPair: vi.fn() } as never,
      smartWalletTracker: { evaluateForToken: vi.fn() } as never,
      redis: makeRedis() as never,
      logger: { debug: vi.fn(), error: vi.fn() } as never,
      batchSize: 6,
      minLiquidityUsd: 2_000,
      tokenLookbackHours: 48,
    });

    await scanner.tick();

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]![0];
    expect(args.where.dex).toBeUndefined();
    expect(args.where.liquidityUsd).toEqual({ gte: 2_000 });
    expect(args.take).toBe(24);
  });

  it('claims each mint via Redis SET NX before evaluating it, and stops at batchSize', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 't1', mint: 'mint1' },
      { id: 't2', mint: 'mint2' },
      { id: 't3', mint: 'mint3' },
    ]);
    const evaluateForToken = vi.fn().mockResolvedValue(undefined);
    const getBestSolanaPair = vi.fn().mockResolvedValue({ priceUsd: '1.23' });
    const redis = makeRedis('OK');

    const scanner = new NetworkTradeScannerService({
      prisma: { token: { findMany } } as never,
      dexScreener: { getBestSolanaPair } as never,
      smartWalletTracker: { evaluateForToken } as never,
      redis: redis as never,
      logger: { debug: vi.fn(), error: vi.fn() } as never,
      batchSize: 2,
      minLiquidityUsd: 2_000,
      tokenLookbackHours: 48,
    });

    await scanner.tick();

    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(evaluateForToken).toHaveBeenCalledTimes(2);
    expect(evaluateForToken).toHaveBeenCalledWith('mint1', 't1', undefined, 1.23);
    expect(evaluateForToken).toHaveBeenCalledWith('mint2', 't2', undefined, 1.23);
  });

  it('skips a mint whose Redis claim fails (already scanned recently) without evaluating it', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 't1', mint: 'mint1' },
      { id: 't2', mint: 'mint2' },
    ]);
    const evaluateForToken = vi.fn().mockResolvedValue(undefined);
    const redis = { set: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('OK') };

    const scanner = new NetworkTradeScannerService({
      prisma: { token: { findMany } } as never,
      dexScreener: { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never,
      smartWalletTracker: { evaluateForToken } as never,
      redis: redis as never,
      logger: { debug: vi.fn(), error: vi.fn() } as never,
      batchSize: 2,
      minLiquidityUsd: 2_000,
      tokenLookbackHours: 48,
    });

    await scanner.tick();

    expect(evaluateForToken).toHaveBeenCalledTimes(1);
    expect(evaluateForToken).toHaveBeenCalledWith('mint2', 't2', undefined, undefined);
  });

  it('never throws when evaluateForToken rejects — logs and continues', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 't1', mint: 'mint1' }]);
    const evaluateForToken = vi.fn().mockRejectedValue(new Error('rpc down'));
    const errorLog = vi.fn();

    const scanner = new NetworkTradeScannerService({
      prisma: { token: { findMany } } as never,
      dexScreener: { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never,
      smartWalletTracker: { evaluateForToken } as never,
      redis: makeRedis() as never,
      logger: { debug: vi.fn(), error: errorLog } as never,
      batchSize: 6,
      minLiquidityUsd: 2_000,
      tokenLookbackHours: 48,
    });

    await expect(scanner.tick()).resolves.toBeUndefined();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('never throws when the whole tick fails (e.g. a DB error) — logs instead', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('db down'));
    const errorLog = vi.fn();

    const scanner = new NetworkTradeScannerService({
      prisma: { token: { findMany } } as never,
      dexScreener: { getBestSolanaPair: vi.fn() } as never,
      smartWalletTracker: { evaluateForToken: vi.fn() } as never,
      redis: makeRedis() as never,
      logger: { debug: vi.fn(), error: errorLog } as never,
      batchSize: 6,
      minLiquidityUsd: 2_000,
      tokenLookbackHours: 48,
    });

    await expect(scanner.tick()).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});
