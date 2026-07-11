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

/** A signed-looking transaction: broadcastTransaction reads signatures[0] via bs58. */
function fakeSignedVersionedTx(): VersionedTransaction {
  return Object.assign(Object.create(VersionedTransaction.prototype), {
    signatures: [new Uint8Array(64).fill(1)],
  }) as VersionedTransaction;
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
      transaction: fakeSignedVersionedTx(),
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

    const fakeTx = fakeSignedVersionedTx();
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
        findUnique: vi.fn().mockResolvedValue({
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
    const fakeTx = fakeSignedVersionedTx();
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
        findUnique: vi.fn().mockResolvedValue({
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

describe('PositionManager Jito bundle broadcast', () => {
  it('sends via a Jito bundle (tip + swap) when configured, and confirms by the swap tx signature', async () => {
    const fakeTx = fakeSignedVersionedTx();
    const jupiter = {
      prepareSwap: vi.fn().mockResolvedValue({ transaction: fakeTx }),
      getQuote: vi.fn(),
    } as never;
    const sendBundle = vi.fn().mockResolvedValue('bundle-id-123');
    const jito = { sendBundle } as never;
    const sendTransaction = vi.fn();
    const confirmTransaction = vi.fn().mockResolvedValue(undefined);
    const connection = {
      getLatestBlockhash: vi
        .fn()
        .mockResolvedValue({ blockhash: 'So11111111111111111111111111111111111111112' }),
      sendTransaction,
      confirmTransaction,
      getParsedTransaction: vi
        .fn()
        .mockResolvedValue({ meta: { preTokenBalances: [], postTokenBalances: [] } }),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
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
      false,
      undefined,
      jito,
    );

    await manager.openPosition(BASE_PARAMS);

    expect(sendBundle).toHaveBeenCalledTimes(1);
    const bundleArg = sendBundle.mock.calls[0]![0];
    expect(bundleArg).toHaveLength(2); // [tipTx, swapTx]
    expect(bundleArg[1]).toBe(fakeTx);
    expect(sendTransaction).not.toHaveBeenCalled(); // never falls through when the bundle succeeds
    expect(confirmTransaction).toHaveBeenCalledTimes(1);
  });

  it('falls back to a direct send when Jito bundle submission fails, never blocking the trade', async () => {
    const fakeTx = fakeSignedVersionedTx();
    const jupiter = {
      prepareSwap: vi.fn().mockResolvedValue({ transaction: fakeTx }),
      getQuote: vi.fn(),
    } as never;
    const jito = {
      sendBundle: vi.fn().mockRejectedValue(new Error('block engine unreachable')),
    } as never;
    const sendTransaction = vi.fn().mockResolvedValue('direct-sig');
    const connection = {
      getLatestBlockhash: vi
        .fn()
        .mockResolvedValue({ blockhash: 'So11111111111111111111111111111111111111112' }),
      sendTransaction,
      confirmTransaction: vi.fn().mockResolvedValue(undefined),
      getParsedTransaction: vi
        .fn()
        .mockResolvedValue({ meta: { preTokenBalances: [], postTokenBalances: [] } }),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
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
      false,
      undefined,
      jito,
    );

    const { trade } = await manager.openPosition(BASE_PARAMS);

    expect(trade.id).toBe('trade-1');
    expect(sendTransaction).toHaveBeenCalledWith(fakeTx);
  });
});

describe('PositionManager notification content', () => {
  it('openPosition looks up the token dex and includes it on the BUY notification', async () => {
    const jupiter = {
      prepareSwap: vi.fn().mockResolvedValue({ transaction: fakeSignedVersionedTx() }),
      getQuote: vi.fn(),
    } as never;
    const connection = {
      sendTransaction: vi.fn().mockResolvedValue('sig123'),
      confirmTransaction: vi.fn().mockResolvedValue(undefined),
      getParsedTransaction: vi
        .fn()
        .mockResolvedValue({ meta: { preTokenBalances: [], postTokenBalances: [] } }),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const dexRegistry = { getExecutor: vi.fn() } as never;
    const prisma = {
      trade: { create: vi.fn().mockResolvedValue({ id: 'trade-1' }) },
      position: { create: vi.fn().mockResolvedValue({ id: 'position-1' }) },
      token: { findUnique: vi.fn().mockResolvedValue({ dex: 'PUMPSWAP' }) },
    } as never;
    const notifier = { notifyTrade: vi.fn(), notifyExit: vi.fn() } as never;

    const manager = new PositionManager(
      prisma,
      connection,
      jupiter,
      dexScreener,
      fakeLogger(),
      fakeSafety(),
      notifier,
      false,
      dexRegistry,
    );

    await manager.openPosition(BASE_PARAMS);

    expect(
      (notifier as { notifyTrade: ReturnType<typeof vi.fn> }).notifyTrade,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'BUY', mint: BASE_PARAMS.mint, dex: 'PUMPSWAP' }),
    );
  });

  function fakeClosePositionSetup() {
    const jupiter = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '20000000' }),
    } as never;
    const connection = {} as never;
    const dexScreener = { getBestSolanaPair: vi.fn() } as never;
    const notifier = { notifyTrade: vi.fn(), notifyExit: vi.fn() } as never;
    const prisma = {
      position: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'position-1',
          tokenId: 'token-1',
          entryPriceUsd: 0.001,
          amountToken: 1000,
          token: {
            mint: 'MintAAAA1111111111111111111111111111111111',
            dex: 'PUMPFUN',
            symbol: 'FOO',
          },
        }),
        update: vi.fn().mockResolvedValue({ id: 'position-1', status: 'CLOSED' }),
      },
      trade: { create: vi.fn().mockResolvedValue({ id: 'sell-trade-1' }) },
    } as never;

    const manager = new PositionManager(
      prisma,
      connection,
      jupiter,
      dexScreener,
      fakeLogger(),
      fakeSafety(),
      notifier,
      true, // paper trading — exercises the notification wiring without real swap machinery
    );

    return {
      manager,
      notifier: notifier as {
        notifyTrade: ReturnType<typeof vi.fn>;
        notifyExit: ReturnType<typeof vi.fn>;
      },
    };
  }

  it('closePosition always fires a Sell Signal (notifyTrade), even for a manual close with no exit reason', async () => {
    const { manager, notifier } = fakeClosePositionSetup();

    await manager.closePosition('position-1', 'wallet-1', 'enc', 'key', { currentPriceUsd: 0.002 });

    expect(notifier.notifyTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'SELL',
        mint: 'MintAAAA1111111111111111111111111111111111',
        dex: 'PUMPFUN',
        symbol: 'FOO',
      }),
    );
    // No reason given -- the TP/SL/trailing-specific alert must not fire.
    expect(notifier.notifyExit).not.toHaveBeenCalled();
  });

  it('closePosition fires both the Sell Signal and the reason-specific exit alert for an automated close', async () => {
    const { manager, notifier } = fakeClosePositionSetup();

    await manager.closePosition('position-1', 'wallet-1', 'enc', 'key', {
      currentPriceUsd: 0.002,
      reason: 'take_profit',
    });

    expect(notifier.notifyTrade).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL' }));
    expect(notifier.notifyExit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'take_profit',
        mint: 'MintAAAA1111111111111111111111111111111111',
        dex: 'PUMPFUN',
      }),
    );
  });
});
