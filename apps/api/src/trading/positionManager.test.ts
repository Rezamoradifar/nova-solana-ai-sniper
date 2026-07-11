import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
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

/** The exact signature broadcastTransaction derives from fakeSignedVersionedTx()'s
 *  fixed signature bytes — sendTransaction's own mocked return value is never used
 *  as the signature (broadcastTransaction reads it from the transaction itself). */
const FAKE_TX_SIGNATURE = bs58.encode(new Uint8Array(64).fill(1));

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
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
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
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
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

  it('regression: a transaction that lands but reverts on-chain is never recorded as a successful buy', async () => {
    // Live gap: confirmTransaction only rejects on timeout/expiry — a landed-but-
    // reverted swap (slippage exceeded, program error) resolved normally with no
    // err check, so a reverted buy was previously recorded as CONFIRMED with the
    // real money spent but zero tokens actually received.
    const prepareSwap = vi.fn().mockResolvedValue({ transaction: fakeSignedVersionedTx() });
    const jupiter = { prepareSwap, getQuote: vi.fn() } as never;
    const connection = {
      sendTransaction: vi.fn().mockResolvedValue('sig123'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: { InstructionError: [] } } }),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const dexRegistry = { getExecutor: vi.fn() } as never;
    const tradeCreate = vi.fn().mockResolvedValue({ id: 'trade-failed-1' });
    const prisma = {
      trade: { create: tradeCreate },
      position: { create: vi.fn() },
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
      dexRegistry,
    );

    await expect(manager.openPosition(BASE_PARAMS)).rejects.toThrow(/reverted on-chain/);
    // No Position was ever created for a buy that never actually landed tokens.
    expect(
      (prisma as { position: { create: ReturnType<typeof vi.fn> } }).position.create,
    ).not.toHaveBeenCalled();
    // The failed attempt is still durably recorded in Trade History.
    expect(tradeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ side: 'BUY', status: 'FAILED', walletId: 'wallet-1' }),
    });
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

describe('PositionManager guaranteed exit strategy (regression: live incident 2026-07-11 — positions opened with no TP/SL/trailing at all could never close)', () => {
  it('applies the balanced-preset default when the caller supplies no TP/SL/trailing at all', async () => {
    const jupiter = {
      prepareSwap: vi.fn().mockResolvedValue({ transaction: fakeSignedVersionedTx() }),
      getQuote: vi.fn(),
    } as never;
    const connection = {
      sendTransaction: vi.fn().mockResolvedValue('sig123'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getParsedTransaction: vi
        .fn()
        .mockResolvedValue({ meta: { preTokenBalances: [], postTokenBalances: [] } }),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const positionCreate = vi.fn().mockResolvedValue({ id: 'position-1' });
    const prisma = {
      trade: { create: vi.fn().mockResolvedValue({ id: 'trade-1' }) },
      position: { create: positionCreate },
      token: { findUnique: vi.fn().mockResolvedValue(undefined) },
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
    );

    // Deliberately omits takeProfitPercent/stopLossPercent/trailingStopPercent/
    // trailingStopPreset — mirrors copyTrading.ts and any SnipeConfig with no
    // preset and no manual values set (132/135 of them, live-verified 2026-07-11).
    await manager.openPosition(BASE_PARAMS);

    expect(positionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          takeProfitPercent: undefined,
          stopLossPercent: 25,
          trailingStopPercent: 15,
          trailingStopPreset: 'balanced',
        }),
      }),
    );
  });

  it('never overrides an explicit exit strategy (preset-resolved or manual) with the default', async () => {
    const jupiter = {
      prepareSwap: vi.fn().mockResolvedValue({ transaction: fakeSignedVersionedTx() }),
      getQuote: vi.fn(),
    } as never;
    const connection = {
      sendTransaction: vi.fn().mockResolvedValue('sig123'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getParsedTransaction: vi
        .fn()
        .mockResolvedValue({ meta: { preTokenBalances: [], postTokenBalances: [] } }),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const positionCreate = vi.fn().mockResolvedValue({ id: 'position-1' });
    const prisma = {
      trade: { create: vi.fn().mockResolvedValue({ id: 'trade-1' }) },
      position: { create: positionCreate },
      token: { findUnique: vi.fn().mockResolvedValue(undefined) },
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
    );

    await manager.openPosition({
      ...BASE_PARAMS,
      stopLossPercent: 10,
      trailingStopPercent: 8,
      trailingStopPreset: 'meme_coin',
    });

    expect(positionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          takeProfitPercent: undefined,
          stopLossPercent: 10,
          trailingStopPercent: 8,
          trailingStopPreset: 'meme_coin',
        }),
      }),
    );
  });

  it('respects a partial manual exit strategy (only one field set) without pulling in the default', async () => {
    const jupiter = {
      prepareSwap: vi.fn().mockResolvedValue({ transaction: fakeSignedVersionedTx() }),
      getQuote: vi.fn(),
    } as never;
    const connection = {
      sendTransaction: vi.fn().mockResolvedValue('sig123'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getParsedTransaction: vi
        .fn()
        .mockResolvedValue({ meta: { preTokenBalances: [], postTokenBalances: [] } }),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const positionCreate = vi.fn().mockResolvedValue({ id: 'position-1' });
    const prisma = {
      trade: { create: vi.fn().mockResolvedValue({ id: 'trade-1' }) },
      position: { create: positionCreate },
      token: { findUnique: vi.fn().mockResolvedValue(undefined) },
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
    );

    await manager.openPosition({ ...BASE_PARAMS, takeProfitPercent: 25 });

    expect(positionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          takeProfitPercent: 25,
          stopLossPercent: undefined,
          trailingStopPercent: undefined,
        }),
      }),
    );
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
    const confirmTransaction = vi.fn().mockResolvedValue({ value: { err: null } });
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
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
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

describe('PositionManager live sell failure handling', () => {
  it('regression: a sell that reverts on-chain leaves the position OPEN and records a FAILED trade, never a fabricated CLOSE', async () => {
    const jupiter = {
      prepareSwap: vi.fn().mockResolvedValue({ transaction: fakeSignedVersionedTx() }),
      getQuote: vi.fn(),
    } as never;
    const connection = {
      getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({
        value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: '1000' } } } } } }],
      }),
      sendTransaction: vi.fn().mockResolvedValue('sig-revert'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: { InstructionError: [] } } }),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn() } as never;
    const positionUpdate = vi.fn();
    const tradeCreate = vi.fn().mockResolvedValue({ id: 'trade-failed-sell-1' });
    const prisma = {
      position: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'position-1',
          tokenId: 'token-1',
          walletId: 'wallet-1',
          entryPriceUsd: 0.001,
          amountToken: 1000,
          amountSolInvested: 0.01,
          highWaterMarkUsd: 0.001,
          trailingStopPercent: null,
          closedAt: null,
          createdAt: new Date('2026-07-10T00:00:00Z'),
          token: {
            mint: 'CkWryeENpbbz6Lj4LFQ1ya6U7bJoAbtBkAnSzaeaXCP5',
            dex: 'PUMPFUN',
            poolAddress: null,
            symbol: 'FOO',
            name: 'Foo',
            decimals: 9,
          },
        }),
        update: positionUpdate,
      },
      trade: { create: tradeCreate },
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
    );

    await expect(
      manager.closePosition('position-1', 'wallet-1', 'enc', 'key', { currentPriceUsd: 0.002 }),
    ).rejects.toThrow(/reverted on-chain/);

    // Position must never be marked CLOSED for a sell that didn't actually happen.
    expect(positionUpdate).not.toHaveBeenCalled();
    expect(tradeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ side: 'SELL', status: 'FAILED', walletId: 'wallet-1' }),
    });
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
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
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
    const notifier = {
      notifyTrade: vi.fn(),
      notifyExit: vi.fn(),
      notifyBuyCard: vi.fn(),
      notifySellCard: vi.fn(),
    } as never;

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

  it("openPosition sends a BUY trade card once the token row is available, carrying the caller's aiScore", async () => {
    const jupiter = {
      prepareSwap: vi.fn().mockResolvedValue({ transaction: fakeSignedVersionedTx() }),
      getQuote: vi.fn(),
    } as never;
    const connection = {
      sendTransaction: vi.fn().mockResolvedValue('sig123'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getParsedTransaction: vi
        .fn()
        .mockResolvedValue({ meta: { preTokenBalances: [], postTokenBalances: [] } }),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const dexRegistry = { getExecutor: vi.fn() } as never;
    const prisma = {
      trade: { create: vi.fn().mockResolvedValue({ id: 'trade-1' }) },
      position: { create: vi.fn().mockResolvedValue({ id: 'position-1' }) },
      token: {
        findUnique: vi.fn().mockResolvedValue({
          dex: 'PUMPSWAP',
          decimals: 9,
          mint: BASE_PARAMS.mint,
          name: 'Rage Guy',
          symbol: 'RAGEGUY',
          aiScore: 40,
        }),
      },
    } as never;
    const notifier = {
      notifyTrade: vi.fn(),
      notifyExit: vi.fn(),
      notifyBuyCard: vi.fn(),
      notifySellCard: vi.fn(),
    } as never;

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

    await manager.openPosition({ ...BASE_PARAMS, aiScore: 91 });

    expect(
      (notifier as { notifyBuyCard: ReturnType<typeof vi.fn> }).notifyBuyCard,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: 'position-1',
        entryPriceUsd: expect.any(Number),
        token: expect.objectContaining({ mint: BASE_PARAMS.mint, dex: 'PUMPSWAP', aiScore: 91 }),
      }),
    );
  });

  function fakeClosePositionSetup() {
    const jupiter = {
      getQuote: vi.fn().mockResolvedValue({ outAmount: '20000000' }),
    } as never;
    const connection = {} as never;
    const dexScreener = { getBestSolanaPair: vi.fn() } as never;
    const notifier = {
      notifyTrade: vi.fn(),
      notifyExit: vi.fn(),
      notifyBuyCard: vi.fn(),
      notifySellCard: vi.fn().mockResolvedValue('the share caption'),
    } as never;
    const positionUpdate = vi.fn().mockResolvedValue({ id: 'position-1', status: 'CLOSED' });
    const prisma = {
      position: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'position-1',
          tokenId: 'token-1',
          walletId: 'wallet-1',
          entryPriceUsd: 0.001,
          amountToken: 1000,
          amountSolInvested: 0.01,
          highWaterMarkUsd: 0.001,
          trailingStopPercent: null,
          closedAt: null,
          createdAt: new Date('2026-07-10T00:00:00Z'),
          token: {
            mint: 'MintAAAA1111111111111111111111111111111111',
            dex: 'PUMPFUN',
            symbol: 'FOO',
            name: 'Foo',
            decimals: 9,
          },
        }),
        update: positionUpdate,
      },
      trade: {
        create: vi.fn().mockResolvedValue({ id: 'sell-trade-1' }),
        findFirst: vi.fn().mockResolvedValue({ txSignature: 'buy-sig-1' }),
      },
      wallet: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ publicKey: 'WalletPubkey1111111111111111111111111111' }),
      },
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
        notifyBuyCard: ReturnType<typeof vi.fn>;
        notifySellCard: ReturnType<typeof vi.fn>;
      },
      positionUpdate,
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

  it('closePosition sends a SELL trade card carrying the matched BUY signature, and persists the returned share caption', async () => {
    const { manager, notifier, positionUpdate } = fakeClosePositionSetup();

    await manager.closePosition('position-1', 'wallet-1', 'enc', 'key', {
      currentPriceUsd: 0.002,
      reason: 'take_profit',
    });

    expect(notifier.notifySellCard).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: 'position-1',
        buySignature: 'buy-sig-1',
        sellSignature: expect.any(String),
        exitReason: 'take_profit',
        token: expect.objectContaining({ mint: 'MintAAAA1111111111111111111111111111111111' }),
      }),
    );
    expect(positionUpdate).toHaveBeenCalledWith({
      where: { id: 'position-1' },
      data: { shareCaption: 'the share caption' },
    });
  });

  it('regression: realizedPnlUsd (and therefore the sell card and Position.realizedPnlUsd) is decimal-adjusted, not raw-amountToken', async () => {
    // Live-verified production incident: closing a real position computed
    // realizedPnlUsd from the RAW on-chain integer token amount instead of the
    // decimal-adjusted count, producing a phantom -$395,414.07 "loss" on a real
    // ~-$0.04 close. Position.realizedPnlUsd feeds TradingSafety's daily-loss
    // check directly (see safety.ts dailyRealizedPnlUsd), so this single bad
    // write tripped the daily loss limit and blocked every subsequent trade for
    // the rest of the day — a genuine, not just cosmetic, production bug.
    const { manager, notifier, positionUpdate } = fakeClosePositionSetup();

    await manager.closePosition('position-1', 'wallet-1', 'enc', 'key', {
      currentPriceUsd: 0.002,
      reason: 'take_profit',
    });

    // Mock position: entryPriceUsd 0.001, amountToken 1000 (raw), decimals 9 ->
    // real token count 0.000001 -> correct realizedPnlUsd = (0.002-0.001)*0.000001.
    const expected = 0.000000001;
    const statusUpdateCall = positionUpdate.mock.calls.find(
      (c) => (c[0] as { data: { status?: string } }).data.status === 'CLOSED',
    )!;
    expect(
      (statusUpdateCall[0] as { data: { realizedPnlUsd: number } }).data.realizedPnlUsd,
    ).toBeCloseTo(expected, 12);

    const cardCall = notifier.notifySellCard.mock.calls[0]![0];
    expect(cardCall.profitUsd).toBeCloseTo(expected, 12);
    expect(cardCall.profitUsd).toBeLessThan(0.01); // sanity bound against the raw-amount bug (~1)
  });

  it('closePosition maps an undefined exit reason to "manual" on the sell card', async () => {
    const { manager, notifier } = fakeClosePositionSetup();

    await manager.closePosition('position-1', 'wallet-1', 'enc', 'key', { currentPriceUsd: 0.002 });

    expect(notifier.notifySellCard).toHaveBeenCalledWith(
      expect.objectContaining({ exitReason: 'manual' }),
    );
  });

  it('closePosition never persists a share caption when notifySellCard returns undefined', async () => {
    const { manager, notifier, positionUpdate } = fakeClosePositionSetup();
    notifier.notifySellCard.mockResolvedValueOnce(undefined);

    await manager.closePosition('position-1', 'wallet-1', 'enc', 'key', { currentPriceUsd: 0.002 });

    expect(positionUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shareCaption: expect.anything() }),
      }),
    );
  });

  it('closePosition still reports success (already-executed sell is never undone) even if the card/DB lookups throw', async () => {
    const { manager, notifier } = fakeClosePositionSetup();
    (
      manager as unknown as { prisma: { trade: { findFirst: ReturnType<typeof vi.fn> } } }
    ).prisma.trade.findFirst = vi.fn().mockRejectedValue(new Error('db blip'));

    const result = await manager.closePosition('position-1', 'wallet-1', 'enc', 'key', {
      currentPriceUsd: 0.002,
      reason: 'take_profit',
    });

    expect(result.closed).toBe(true);
    expect(notifier.notifySellCard).not.toHaveBeenCalled();
  });
});

describe('PositionManager unverified-swap lock (regression: live incident 2026-07-11)', () => {
  // Live-verified: a sell landed on-chain successfully, but the follow-up RPC call
  // that reads back the actual SOL received (getActualSolDelta) failed. Before this
  // guard, the position was left OPEN with its original amountToken untouched, so
  // the next PriceMonitor tick saw the same still-open position and submitted a
  // SECOND real sell of the same recorded amount — succeeding again because the
  // wallet held unrelated tokens of the same mint, draining them too. A third tick
  // did it again. This test proves a second closePosition call for the same
  // position is refused outright, with zero further swap calls, once that happens.
  it('closePosition refuses to resubmit a sell for a position whose previous swap landed but failed verification', async () => {
    const jupiter = {
      prepareSwap: vi.fn().mockResolvedValue({ transaction: fakeSignedVersionedTx() }),
      getQuote: vi.fn(),
    } as never;
    const sendTransaction = vi.fn().mockResolvedValue('sig-verify-fail-1');
    const connection = {
      getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({
        value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: '1000' } } } } } }],
      }),
      sendTransaction,
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      // Simulates the exact live failure: the swap confirmed, but reading it back
      // to compute the actual SOL received fails (e.g. an RPC outage right after).
      getParsedTransaction: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn() } as never;
    const tradeCreate = vi.fn().mockResolvedValue({ id: 'trade-1' });
    const notifyError = vi.fn();
    const prisma = {
      position: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'position-1',
          tokenId: 'token-1',
          walletId: 'wallet-1',
          entryPriceUsd: 0.001,
          amountToken: 1000,
          amountSolInvested: 0.01,
          highWaterMarkUsd: 0.001,
          trailingStopPercent: null,
          closedAt: null,
          createdAt: new Date('2026-07-10T00:00:00Z'),
          token: {
            mint: 'CkWryeENpbbz6Lj4LFQ1ya6U7bJoAbtBkAnSzaeaXCP5',
            dex: 'PUMPFUN',
            poolAddress: null,
            symbol: 'FOO',
            name: 'Foo',
            decimals: 9,
          },
        }),
        update: vi.fn(),
      },
      trade: { create: tradeCreate },
    } as never;
    const notifier = { notifyError } as never;

    const manager = new PositionManager(
      prisma,
      connection,
      jupiter,
      dexScreener,
      fakeLogger(),
      fakeSafety(),
      notifier,
      false, // live trading
      undefined,
      undefined,
      undefined,
      0, // verificationRetryDelayMs — no real delay in tests
    );

    // First attempt: swap lands, verification fails.
    await expect(
      manager.closePosition('position-1', 'wallet-1', 'enc', 'key', { currentPriceUsd: 0.002 }),
    ).rejects.toThrow();
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(tradeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        side: 'SELL',
        status: 'FAILED',
        txSignature: FAKE_TX_SIGNATURE,
      }),
    });
    expect(notifyError).toHaveBeenCalledTimes(1);

    // Second attempt (e.g. the next PriceMonitor tick): must be refused outright,
    // with no new swap ever submitted — this is the actual fix.
    await expect(
      manager.closePosition('position-1', 'wallet-1', 'enc', 'key', { currentPriceUsd: 0.002 }),
    ).rejects.toThrow(/could not be verified/);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('openPosition refuses to resubmit a buy for a wallet+token whose previous swap landed but failed verification', async () => {
    const jupiter = {
      prepareSwap: vi.fn().mockResolvedValue({ transaction: fakeSignedVersionedTx() }),
      getQuote: vi.fn(),
    } as never;
    const sendTransaction = vi.fn().mockResolvedValue('sig-buy-verify-fail-1');
    const connection = {
      sendTransaction,
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getParsedTransaction: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const tradeCreate = vi.fn().mockResolvedValue({ id: 'trade-1' });
    const notifyError = vi.fn();
    const prisma = {
      trade: { create: tradeCreate },
      position: { create: vi.fn() },
      token: { findUnique: vi.fn().mockResolvedValue(undefined) },
    } as never;
    const notifier = { notifyError } as never;

    const manager = new PositionManager(
      prisma,
      connection,
      jupiter,
      dexScreener,
      fakeLogger(),
      fakeSafety(),
      notifier,
      false, // live trading
      undefined,
      undefined,
      undefined,
      0, // verificationRetryDelayMs — no real delay in tests
    );

    await expect(manager.openPosition(BASE_PARAMS)).rejects.toThrow();
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(tradeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        side: 'BUY',
        status: 'FAILED',
        txSignature: FAKE_TX_SIGNATURE,
      }),
    });

    await expect(manager.openPosition(BASE_PARAMS)).rejects.toThrow(/could not be verified/);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  // Root-cause investigation 2026-07-12: two real production BUYs failed verification
  // on the FIRST attempt with "Could not fetch confirmed transaction" — a transient
  // RPC-propagation-lag error, not a real problem. Proves the retry recovers instead
  // of needlessly locking the wallet+token out of trading.
  it('openPosition recovers automatically when verification succeeds on a retry after transient RPC failures', async () => {
    const jupiter = {
      prepareSwap: vi.fn().mockResolvedValue({ transaction: fakeSignedVersionedTx() }),
      getQuote: vi.fn(),
    } as never;
    const sendTransaction = vi.fn().mockResolvedValue('sig-buy-retry-1');
    const getParsedTransaction = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockResolvedValueOnce({ meta: { preTokenBalances: [], postTokenBalances: [] } });
    const connection = {
      sendTransaction,
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getParsedTransaction,
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const tradeCreate = vi.fn().mockResolvedValue({ id: 'trade-1' });
    const prisma = {
      trade: { create: tradeCreate },
      position: { create: vi.fn().mockResolvedValue({ id: 'position-1' }) },
      token: { findUnique: vi.fn().mockResolvedValue(undefined) },
    } as never;
    const notifyError = vi.fn();
    const notifier = { notifyError, notifyTrade: vi.fn() } as never;

    const manager = new PositionManager(
      prisma,
      connection,
      jupiter,
      dexScreener,
      fakeLogger(),
      fakeSafety(),
      notifier,
      false,
      undefined,
      undefined,
      undefined,
      0,
    );

    const { trade } = await manager.openPosition(BASE_PARAMS);

    expect(trade.id).toBe('trade-1');
    expect(sendTransaction).toHaveBeenCalledTimes(1); // only ONE real swap submitted
    expect(getParsedTransaction).toHaveBeenCalledTimes(3); // 2 failed + 1 succeeded verification calls
    expect(notifyError).not.toHaveBeenCalled();
  });

  // Root-cause investigation 2026-07-12: the old Set-based lock never expired — once
  // verification failed, that wallet+token pair was blocked from ever buying again
  // until the whole API process restarted. Proves the lock now auto-recovers on its
  // own after the TTL, so trading is never permanently blocked.
  it('openPosition auto-recovers a stuck verification lock after the TTL elapses, never blocking trading forever', async () => {
    const jupiter = {
      prepareSwap: vi.fn().mockResolvedValue({ transaction: fakeSignedVersionedTx() }),
      getQuote: vi.fn(),
    } as never;
    const sendTransaction = vi.fn().mockResolvedValue('sig-buy-ttl-1');
    const connection = {
      sendTransaction,
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      // Every verification attempt fails on the first swap (locks); succeeds on the
      // swap submitted after the TTL has elapsed.
      getParsedTransaction: vi
        .fn()
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockResolvedValue({ meta: { preTokenBalances: [], postTokenBalances: [] } }),
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn().mockResolvedValue(undefined) } as never;
    const tradeCreate = vi.fn().mockResolvedValue({ id: 'trade-1' });
    const prisma = {
      trade: { create: tradeCreate },
      position: { create: vi.fn().mockResolvedValue({ id: 'position-1' }) },
      token: { findUnique: vi.fn().mockResolvedValue(undefined) },
    } as never;
    const notifier = { notifyError: vi.fn(), notifyTrade: vi.fn() } as never;

    const manager = new PositionManager(
      prisma,
      connection,
      jupiter,
      dexScreener,
      fakeLogger(),
      fakeSafety(),
      notifier,
      false,
      undefined,
      undefined,
      undefined,
      0,
    );

    vi.useFakeTimers();
    try {
      // First attempt: swap lands, verification fails after retries -> locked.
      await expect(manager.openPosition(BASE_PARAMS)).rejects.toThrow();

      // Immediately retrying is still refused — the lock is active.
      await expect(manager.openPosition(BASE_PARAMS)).rejects.toThrow(
        /could not be verified.*refusing to submit another swap/,
      );
      expect(sendTransaction).toHaveBeenCalledTimes(1);

      // Advance past the 10-minute reconciliation TTL.
      vi.advanceTimersByTime(11 * 60 * 1000);

      // Lock has auto-expired: a fresh swap is submitted and this time succeeds.
      const { trade } = await manager.openPosition(BASE_PARAMS);
      expect(trade.id).toBe('trade-1');
      expect(sendTransaction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PositionManager zero-balance reconciliation (regression: live incident 2026-07-11)', () => {
  // Live-verified: a position recorded OPEN with a confirmed, on-chain-verified buy
  // on file had a wallet balance of exactly 0 for that mint — the tokens left the
  // wallet through a path this bot never recorded (no sell had ever landed through
  // this codebase). Before this fix, PriceMonitor retried the sell every tick
  // forever: sellAmountRaw resolved to 0 each time, the PumpSwap program rejected
  // the zero-amount swap outright, and the position stayed OPEN indefinitely with
  // no path to resolution. This proves that case is now detected before any swap
  // is even attempted, and the position is closed (no realized PnL guessed) rather
  // than retried.
  it('closes the position and never attempts a swap when the real wallet balance is 0', async () => {
    const jupiter = { prepareSwap: vi.fn(), getQuote: vi.fn() } as never;
    const sendTransaction = vi.fn();
    const connection = {
      // Empty token account list — real on-chain balance is 0 for this mint.
      getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] }),
      sendTransaction,
    } as never;
    const dexScreener = { getBestSolanaPair: vi.fn() } as never;
    const tradeCreate = vi.fn().mockResolvedValue({ id: 'trade-1' });
    const positionUpdate = vi.fn().mockResolvedValue({ id: 'position-1', status: 'CLOSED' });
    const notifyError = vi.fn();
    const prisma = {
      position: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'position-1',
          tokenId: 'token-1',
          walletId: 'wallet-1',
          entryPriceUsd: 0.0006949,
          amountToken: 11169682606,
          amountSolInvested: 0.1,
          highWaterMarkUsd: 0.0007101,
          trailingStopPercent: 15,
          closedAt: null,
          createdAt: new Date('2026-07-11T15:45:57Z'),
          token: {
            mint: 'GnM6XZ7DN9KSPW2ZVMNqCggsxjnxHMGb2t4kiWrUpump',
            dex: 'PUMPSWAP',
            poolAddress: 'DW6rLxPNi9nH42jinmToY8ii13UaeeDmC9sanLu2zUxD',
            symbol: 'WAGMI',
            name: 'WAGMI',
            decimals: 9,
          },
        }),
        update: positionUpdate,
      },
      trade: { create: tradeCreate },
    } as never;
    const notifier = { notifyError } as never;

    const manager = new PositionManager(
      prisma,
      connection,
      jupiter,
      dexScreener,
      fakeLogger(),
      fakeSafety(),
      notifier,
      false, // live trading
      undefined,
      undefined,
      undefined,
      0, // verificationRetryDelayMs — no real delay in tests
    );

    const result = await manager.closePosition('position-1', 'wallet-1', 'enc', 'key', {
      currentPriceUsd: 0.0005859,
    });

    expect(result.closed).toBe(true);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(positionUpdate).toHaveBeenCalledWith({
      where: { id: 'position-1' },
      data: { status: 'CLOSED', closedAt: expect.any(Date) },
    });
    // No realizedPnlUsd is ever passed — a guessed number would be worse than none.
    expect(positionUpdate.mock.calls[0]![0].data).not.toHaveProperty('realizedPnlUsd');
    expect(tradeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ side: 'SELL', status: 'FAILED', amountToken: 0 }),
    });
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0]![1]).toMatch(/wallet holds 0/);
  });
});
