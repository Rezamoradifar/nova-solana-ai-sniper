import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@nova/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nova/shared')>();
  return { ...actual, unsealKeypair: vi.fn(() => Keypair.generate()) };
});

import { PositionManager } from './positionManager.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakeSafety() {
  return { checkBeforeOpen: vi.fn().mockResolvedValue({ allowed: true }) } as never;
}

const BASE_PARAMS = {
  userId: 'user-1',
  walletId: 'wallet-1',
  walletPublicKey: 'WalletPubkey1111111111111111111111111111',
  encryptedSecret: 'enc',
  encryptionKey: 'key',
  tokenId: 'token-1',
  mint: 'MintAAAA1111111111111111111111111111111111',
  amountSol: 0.01,
  slippageBps: 300,
};

describe('PositionManager live-swap fallback (openPosition)', () => {
  it('uses Jupiter directly and never touches the native registry when Jupiter succeeds', async () => {
    const prepareSwap = vi.fn().mockResolvedValue({
      transaction: { serialize: () => Buffer.alloc(0) },
    });
    const jupiter = { prepareSwap, getQuote: vi.fn() } as never;
    const connection = {
      sendTransaction: vi.fn().mockResolvedValue('sig123'),
      confirmTransaction: vi.fn().mockResolvedValue(undefined),
      getParsedTransaction: vi.fn().mockResolvedValue({
        meta: { preTokenBalances: [], postTokenBalances: [] },
      }),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const dexRegistry = { getExecutor: vi.fn() } as never;
    const prisma = {
      trade: { create: vi.fn().mockResolvedValue({ id: 'trade-1' }) },
      position: { create: vi.fn().mockResolvedValue({ id: 'position-1' }) },
      token: { findUnique: vi.fn() },
    } as never;

    const manager = new PositionManager(
      prisma,
      connection,
      jupiter,
      dexScreener,
      fakeLogger(),
      fakeSafety(),
      undefined,
      false, // live trading
      dexRegistry,
    );

    await manager.openPosition(BASE_PARAMS);

    expect(prepareSwap).toHaveBeenCalledTimes(1);
    expect(
      (dexRegistry as { getExecutor: ReturnType<typeof vi.fn> }).getExecutor,
    ).not.toHaveBeenCalled();
  });

  it('falls back to the native executor when Jupiter throws, and never sends without a clean simulation', async () => {
    const jupiter = {
      prepareSwap: vi.fn().mockRejectedValue(new Error('no route found')),
      getQuote: vi.fn(),
    } as never;

    const fakeTx = Object.create(VersionedTransaction.prototype) as VersionedTransaction;
    const buildSwap = vi.fn().mockResolvedValue(fakeTx);
    const executor = { dex: 'PUMPSWAP', buildSwap };
    const dexRegistry = { getExecutor: vi.fn().mockReturnValue(executor) } as never;

    const connection = {
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      sendTransaction: vi.fn().mockResolvedValue('native-sig-456'),
      confirmTransaction: vi.fn().mockResolvedValue(undefined),
      getParsedTransaction: vi.fn().mockResolvedValue({
        meta: { preTokenBalances: [], postTokenBalances: [] },
      }),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const prisma = {
      trade: { create: vi.fn().mockResolvedValue({ id: 'trade-1' }) },
      position: { create: vi.fn().mockResolvedValue({ id: 'position-1' }) },
      token: {
        findUnique: vi
          .fn()
          .mockResolvedValue({
            dex: 'PUMPSWAP',
            poolAddress: 'Pool111111111111111111111111111111111111',
          }),
      },
    } as never;

    const manager = new PositionManager(
      prisma,
      connection,
      jupiter,
      dexScreener,
      fakeLogger(),
      fakeSafety(),
      undefined,
      false,
      dexRegistry,
    );

    const { trade } = await manager.openPosition(BASE_PARAMS);

    expect(trade.id).toBe('trade-1');
    expect(buildSwap).toHaveBeenCalledWith(
      expect.objectContaining({ poolAddress: 'Pool111111111111111111111111111111111111' }),
    );
    expect(
      (connection as { simulateTransaction: ReturnType<typeof vi.fn> }).simulateTransaction,
    ).toHaveBeenCalledTimes(1);
    expect(
      (connection as { sendTransaction: ReturnType<typeof vi.fn> }).sendTransaction,
    ).toHaveBeenCalledWith(fakeTx);
  });

  it('never sends the native fallback transaction when simulation fails, and surfaces an error', async () => {
    const jupiter = {
      prepareSwap: vi.fn().mockRejectedValue(new Error('no route found')),
      getQuote: vi.fn(),
    } as never;
    const fakeTx = Object.create(VersionedTransaction.prototype) as VersionedTransaction;
    const executor = { dex: 'PUMPSWAP', buildSwap: vi.fn().mockResolvedValue(fakeTx) };
    const dexRegistry = { getExecutor: vi.fn().mockReturnValue(executor) } as never;

    const sendTransaction = vi.fn();
    const connection = {
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: 'InstructionError' } }),
      sendTransaction,
      confirmTransaction: vi.fn(),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const prisma = {
      token: {
        findUnique: vi
          .fn()
          .mockResolvedValue({
            dex: 'PUMPSWAP',
            poolAddress: 'Pool111111111111111111111111111111111111',
          }),
      },
    } as never;

    const manager = new PositionManager(
      prisma,
      connection,
      jupiter,
      dexScreener,
      fakeLogger(),
      fakeSafety(),
      undefined,
      false,
      dexRegistry,
    );

    await expect(manager.openPosition(BASE_PARAMS)).rejects.toThrow(/simulation failed/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('rethrows the original Jupiter error when no native executor is available for the token', async () => {
    const jupiterErr = new Error('no route found');
    const jupiter = {
      prepareSwap: vi.fn().mockRejectedValue(jupiterErr),
      getQuote: vi.fn(),
    } as never;
    const connection = { sendTransaction: vi.fn(), confirmTransaction: vi.fn() } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const prisma = {
      token: { findUnique: vi.fn().mockResolvedValue({ dex: 'PUMPFUN', poolAddress: null }) },
    } as never;

    // No dexRegistry at all -- must fall through cleanly to the original error.
    const manager = new PositionManager(
      prisma,
      connection,
      jupiter,
      dexScreener,
      fakeLogger(),
      fakeSafety(),
      undefined,
      false,
    );

    await expect(manager.openPosition(BASE_PARAMS)).rejects.toBe(jupiterErr);
  });
});
