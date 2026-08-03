import { PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { PUMPSWAP_PROGRAM_ID } from './pumpswap.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

vi.mock('./pumpswap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pumpswap.js')>();
  return {
    ...actual,
    PumpSwapMonitor: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
    getPumpSwapLiquidity: vi.fn(),
    getPumpSwapPoolState: vi.fn(),
  };
});
vi.mock('./raydium.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./raydium.js')>();
  return {
    ...actual,
    RaydiumCpmmMonitor: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
    getRaydiumCpmmLiquidity: vi.fn(),
    getRaydiumCpmmPoolState: vi.fn(),
  };
});
vi.mock('./orca.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orca.js')>();
  return {
    ...actual,
    OrcaWhirlpoolMonitor: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
    getOrcaWhirlpoolLiquidity: vi.fn(),
    getOrcaWhirlpoolState: vi.fn(),
  };
});
vi.mock('./meteora.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./meteora.js')>();
  return {
    ...actual,
    MeteoraDlmmMonitor: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
    getMeteoraDlmmLiquidity: vi.fn(),
    getMeteoraDlmmPoolState: vi.fn(),
  };
});

import { DexRegistry } from './registry.js';
import { getPumpSwapLiquidity, getPumpSwapPoolState } from './pumpswap.js';
import { getRaydiumCpmmPoolState } from './raydium.js';

describe('DexRegistry — ENABLED_NATIVE_DEXES filtering (2026-07-29)', () => {
  it('registers all 4 DEXs by default, unchanged from before this feature', () => {
    const registry = new DexRegistry({} as never, {} as never, fakeLogger());
    expect([...registry.monitors.keys()].sort()).toEqual([
      'METEORA',
      'ORCA',
      'PUMPSWAP',
      'RAYDIUM',
    ]);
    expect(registry.getAdapter('ORCA')).toBeDefined();
  });

  it('only registers the enabled subset — a disabled DEX has no monitor, liquidity reader, executor, or adapter', () => {
    const registry = new DexRegistry(
      {} as never,
      {} as never,
      fakeLogger(),
      {},
      undefined,
      new Set(['PUMPSWAP', 'RAYDIUM']),
    );
    expect([...registry.monitors.keys()].sort()).toEqual(['PUMPSWAP', 'RAYDIUM']);
    expect(registry.getExecutor('ORCA')).toBeUndefined();
    expect(registry.getAdapter('METEORA')).toBeUndefined();
  });

  it('an empty enabled set disables every native DEX (Jupiter remains the only path)', () => {
    const registry = new DexRegistry(
      {} as never,
      {} as never,
      fakeLogger(),
      {},
      undefined,
      new Set(),
    );
    expect(registry.monitors.size).toBe(0);
    expect(registry.getExecutor('PUMPSWAP')).toBeUndefined();
    expect(registry.getAdapter('PUMPSWAP')).toBeUndefined();
  });
});

describe('DexRegistry', () => {
  it('starts and stops every registered monitor', () => {
    const registry = new DexRegistry({} as never, {} as never, fakeLogger());
    const onLaunch = vi.fn();
    registry.startAll(onLaunch);
    for (const monitor of registry.monitors.values()) {
      expect(monitor.start).toHaveBeenCalledWith(onLaunch);
    }
  });

  it('passes a per-DEX onRawActivity callback through to each monitor when given (2026-07-15 Helius credit audit)', () => {
    const registry = new DexRegistry({} as never, {} as never, fakeLogger());
    const onLaunch = vi.fn();
    const onRawActivity = vi.fn();
    registry.startAll(onLaunch, onRawActivity);

    for (const [dex, monitor] of registry.monitors) {
      expect(monitor.start).toHaveBeenCalledWith(onLaunch, expect.any(Function));
      const rawActivityArg = vi.mocked(monitor.start).mock.calls[0]![1] as () => void;
      rawActivityArg();
      expect(onRawActivity).toHaveBeenCalledWith(dex);
    }
  });

  it('returns undefined liquidity for a dex with no native reader (PUMPFUN/JUPITER)', async () => {
    const registry = new DexRegistry({} as never, {} as never, fakeLogger());
    expect(await registry.getLiquidity('PUMPFUN', 'anyPool')).toBeUndefined();
    expect(await registry.getLiquidity('JUPITER', 'anyPool')).toBeUndefined();
  });

  it('delegates getLiquidity to the correct per-DEX reader', async () => {
    vi.mocked(getPumpSwapLiquidity).mockResolvedValueOnce({
      dex: 'PUMPSWAP',
      poolAddress: 'PoolA',
      baseMint: 'MintA',
      quoteMint: 'So11111111111111111111111111111111111111112',
      baseReserve: 1,
      quoteReserve: 2,
      liquidityUsd: 100,
    });
    const registry = new DexRegistry({} as never, {} as never, fakeLogger());
    const result = await registry.getLiquidity('PUMPSWAP', 'PoolA');
    expect(result?.liquidityUsd).toBe(100);
  });

  it('returns a NotImplementedNativeExecutor by default that fails loudly rather than no-opping', async () => {
    const registry = new DexRegistry({} as never, {} as never, fakeLogger());
    const executor = registry.getExecutor('RAYDIUM');
    expect(executor).toBeDefined();
    await expect(executor!.buildSwap({} as never)).rejects.toThrow(/No native RAYDIUM executor/);
  });

  it('uses a provided executor override instead of the NotImplemented stub', () => {
    const customExecutor = { dex: 'PUMPSWAP', buildSwap: vi.fn() };
    const registry = new DexRegistry({} as never, {} as never, fakeLogger(), {
      PUMPSWAP: customExecutor as never,
    });
    expect(registry.getExecutor('PUMPSWAP')).toBe(customExecutor);
  });

  it('resolveNewPool skips known non-pool accounts and finds the real pool among candidates', async () => {
    const poolAddress = 'CcYbXbMHr2o9Vyz2wmJcRvi59wh42xkXf6qrzChbHPN5';
    const noiseAddress = '2uTUzoGAyTqVAQoitEj6qAtLiJKBoFszFJZm7pusNoRB';

    vi.mocked(getPumpSwapLiquidity).mockImplementation(async (_c, _d, _o, addr) => {
      if (addr !== poolAddress) return undefined;
      return {
        dex: 'PUMPSWAP',
        poolAddress,
        baseMint: 'MintA',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseReserve: 1,
        quoteReserve: 2,
        liquidityUsd: 500,
      };
    });

    const getMultipleAccountsInfo = vi
      .fn()
      .mockImplementation(async (pubkeys: PublicKey[]) =>
        pubkeys.map((pubkey) =>
          pubkey.toBase58() === poolAddress
            ? { owner: PUMPSWAP_PROGRAM_ID, data: Buffer.alloc(10) }
            : { owner: new PublicKey('11111111111111111111111111111111'), data: Buffer.alloc(10) },
        ),
      );

    const registry = new DexRegistry(
      { getMultipleAccountsInfo } as never,
      {} as never,
      fakeLogger(),
    );

    const tx = {
      transaction: {
        message: {
          accountKeys: [
            {
              pubkey: new PublicKey('11111111111111111111111111111111'),
              writable: false,
              signer: false,
            },
            { pubkey: new PublicKey(noiseAddress), writable: true, signer: false },
            { pubkey: new PublicKey(poolAddress), writable: true, signer: false },
          ],
        },
      },
    } as never;

    const result = await registry.resolveNewPool('PUMPSWAP', tx);
    expect(result?.poolAddress).toBe(poolAddress);
    expect(result?.liquidityUsd).toBe(500);
  });

  it('resolveNewPool returns undefined when no candidate account matches', async () => {
    vi.mocked(getPumpSwapLiquidity).mockResolvedValue(undefined);
    const getMultipleAccountsInfo = vi.fn().mockResolvedValue([null]);
    const registry = new DexRegistry(
      { getMultipleAccountsInfo } as never,
      {} as never,
      fakeLogger(),
    );
    const tx = {
      transaction: {
        message: {
          accountKeys: [
            {
              pubkey: new PublicKey('9Nkgzsqenp9a87akazm9zQc4eduTa7w2bd8ynvsJCoUf'),
              writable: true,
              signer: false,
            },
          ],
        },
      },
    } as never;
    expect(await registry.resolveNewPool('PUMPSWAP', tx)).toBeUndefined();
  });

  describe('getVaultAddresses', () => {
    it('dispatches to the right DEX decoder and returns its vault addresses', async () => {
      vi.mocked(getPumpSwapPoolState).mockResolvedValue({
        poolAddress: 'PoolA',
        poolBaseTokenAccount: 'VaultBase',
        poolQuoteTokenAccount: 'VaultQuote',
      } as never);
      const registry = new DexRegistry({} as never, {} as never, fakeLogger());

      expect(await registry.getVaultAddresses('PUMPSWAP', 'PoolA')).toEqual([
        'VaultBase',
        'VaultQuote',
      ]);
    });

    it('returns an empty array when the pool account cannot be decoded', async () => {
      vi.mocked(getRaydiumCpmmPoolState).mockResolvedValue(undefined);
      const registry = new DexRegistry({} as never, {} as never, fakeLogger());

      expect(await registry.getVaultAddresses('RAYDIUM', 'PoolB')).toEqual([]);
    });

    it('returns an empty array instead of throwing when the decoder rejects', async () => {
      vi.mocked(getPumpSwapPoolState).mockRejectedValue(new Error('rpc blip'));
      const registry = new DexRegistry({} as never, {} as never, fakeLogger());

      expect(await registry.getVaultAddresses('PUMPSWAP', 'PoolA')).toEqual([]);
    });
  });

  describe('getAdapter', () => {
    it('returns undefined for a dex with no native reader (PUMPFUN/JUPITER)', () => {
      const registry = new DexRegistry({} as never, {} as never, fakeLogger());
      expect(registry.getAdapter('PUMPFUN')).toBeUndefined();
      expect(registry.getAdapter('JUPITER')).toBeUndefined();
    });

    it('returns a DexAdapter for every registered NativeDexName', () => {
      const registry = new DexRegistry({} as never, {} as never, fakeLogger());
      for (const dex of ['PUMPSWAP', 'RAYDIUM', 'ORCA', 'METEORA'] as const) {
        const adapter = registry.getAdapter(dex);
        expect(adapter).toBeDefined();
        expect(adapter!.dex).toBe(dex);
      }
    });

    it('adapter.getLiquidity delegates to the same per-DEX reader as registry.getLiquidity', async () => {
      vi.mocked(getPumpSwapLiquidity).mockResolvedValueOnce({
        dex: 'PUMPSWAP',
        poolAddress: 'PoolA',
        baseMint: 'MintA',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseReserve: 1,
        quoteReserve: 2,
        liquidityUsd: 100,
      });
      const registry = new DexRegistry({} as never, {} as never, fakeLogger());
      const result = await registry.getAdapter('PUMPSWAP')!.getLiquidity('PoolA');
      expect(result).toEqual({ liquidityUsd: 100, baseReserve: 1, quoteReserve: 2 });
    });

    it('adapter.isExecutable is false by default (NotImplementedNativeExecutor stub)', () => {
      const registry = new DexRegistry({} as never, {} as never, fakeLogger());
      expect(registry.getAdapter('RAYDIUM')!.isExecutable).toBe(false);
    });

    it('adapter.isExecutable is true when a real executor override is supplied', () => {
      const realExecutor = { dex: 'PUMPSWAP', buildSwap: vi.fn() };
      const registry = new DexRegistry({} as never, {} as never, fakeLogger(), {
        PUMPSWAP: realExecutor as never,
      });
      expect(registry.getAdapter('PUMPSWAP')!.isExecutable).toBe(true);
    });

    it('adapter.executeSwap delegates to the underlying executor.buildSwap and wraps the result', async () => {
      const fakeTx = { fake: 'transaction' };
      const realExecutor = { dex: 'PUMPSWAP', buildSwap: vi.fn().mockResolvedValue(fakeTx) };
      const registry = new DexRegistry({} as never, {} as never, fakeLogger(), {
        PUMPSWAP: realExecutor as never,
      });
      const result = await registry.getAdapter('PUMPSWAP')!.executeSwap({} as never);
      expect(realExecutor.buildSwap).toHaveBeenCalled();
      expect(result).toEqual({ transaction: fakeTx });
    });
  });
});
