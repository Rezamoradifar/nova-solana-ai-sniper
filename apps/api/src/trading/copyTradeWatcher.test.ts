import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { detectCopyBuy, CopyTradeWatcher } from './copyTradeWatcher.js';

const TARGET = '11111111111111111111111111111111';
const TOKEN = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function tx(input: {
  preLamports: number;
  postLamports: number;
  mint: string;
  preToken: number;
  postToken: number;
}): ParsedTransactionWithMeta {
  return {
    transaction: {
      message: {
        accountKeys: [{ pubkey: new PublicKey(TARGET), signer: true }],
        instructions: [{ programId: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') }],
      },
    },
    meta: {
      err: null,
      fee: 0,
      preBalances: [input.preLamports],
      postBalances: [input.postLamports],
      preTokenBalances: [
        {
          accountIndex: 1,
          owner: TARGET,
          mint: input.mint,
          uiTokenAmount: { uiAmount: input.preToken },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          owner: TARGET,
          mint: input.mint,
          uiTokenAmount: { uiAmount: input.postToken },
        },
      ],
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe('detectCopyBuy', () => {
  it('detects a real SOL-funded token balance increase', () => {
    const result = detectCopyBuy(
      tx({
        preLamports: 2_000_000_000,
        postLamports: 1_500_000_000,
        mint: TOKEN,
        preToken: 10,
        postToken: 110,
      }),
      TARGET,
      0.01,
    );

    expect(result).toEqual({
      mint: TOKEN,
      amountSolOriginal: 0.5,
    });
  });

  it('ignores stablecoin balance increases', () => {
    const result = detectCopyBuy(
      tx({
        preLamports: 2_000_000_000,
        postLamports: 1_500_000_000,
        mint: USDC,
        preToken: 10,
        postToken: 110,
      }),
      TARGET,
      0.01,
    );

    expect(result).toBeUndefined();
  });

  it('ignores token changes when source SOL spend is below the configured minimum', () => {
    const result = detectCopyBuy(
      tx({
        preLamports: 2_000_000_000,
        postLamports: 1_995_000_000,
        mint: TOKEN,
        preToken: 0,
        postToken: 100,
      }),
      TARGET,
      0.01,
    );

    expect(result).toBeUndefined();
  });

  it('ignores sells or transfers where target token balance does not increase', () => {
    const result = detectCopyBuy(
      tx({
        preLamports: 2_000_000_000,
        postLamports: 1_500_000_000,
        mint: TOKEN,
        preToken: 100,
        postToken: 20,
      }),
      TARGET,
      0.01,
    );

    expect(result).toBeUndefined();
  });
});

const validTx = () =>
  tx({ preLamports: 2e9, postLamports: 1.5e9, mint: TOKEN, preToken: 0, postToken: 100 });

describe('copy buy transaction validation', () => {
  it('rejects failed transactions, non-signing recipients and transfers without a supported swap', () => {
    const failed = validTx();
    failed.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    expect(detectCopyBuy(failed, TARGET, 0.01)).toBeUndefined();
    const recipient = validTx();
    recipient.transaction.message.accountKeys[0]!.signer = false;
    expect(detectCopyBuy(recipient, TARGET, 0.01)).toBeUndefined();
    const transfer = validTx();
    transfer.transaction.message.instructions = [];
    expect(detectCopyBuy(transfer, TARGET, 0.01)).toBeUndefined();
  });
  it('deducts network fees and new token-account rent from the copied notional', () => {
    const value = validTx();
    value.meta!.fee = 5000;
    value.meta!.postBalances[0]! -= 2_039_280 + 5000;
    value.meta!.preBalances.push(0);
    value.meta!.postBalances.push(2_039_280);
    expect(detectCopyBuy(value, TARGET, 0.01)?.amountSolOriginal).toBeCloseTo(0.5);
  });
  it('supports existing wrapped SOL and rejects multiple received tokens', () => {
    const value = validTx();
    value.meta!.postBalances[0] = 2e9;
    value.meta!.preTokenBalances!.push({
      owner: TARGET,
      accountIndex: 2,
      mint: 'So11111111111111111111111111111111111111112',
      uiTokenAmount: { uiAmount: 1 },
    } as never);
    value.meta!.postTokenBalances!.push({
      owner: TARGET,
      accountIndex: 2,
      mint: 'So11111111111111111111111111111111111111112',
      uiTokenAmount: { uiAmount: 0.5 },
    } as never);
    expect(detectCopyBuy(value, TARGET, 0.01)?.amountSolOriginal).toBe(0.5);
    value.meta!.postTokenBalances!.push({
      owner: TARGET,
      accountIndex: 3,
      mint: 'another',
      uiTokenAmount: { uiAmount: 10 },
    } as never);
    expect(detectCopyBuy(value, TARGET, 0.01)).toBeUndefined();
  });
});

function watcherFixture() {
  const seen = new Set<string>();
  const mirror = vi.fn().mockResolvedValue(undefined);
  const redis = {
    exists: vi.fn(async (key: string) => Number(seen.has(key))),
    set: vi.fn(async (key: string, _value: string, _ex: string, _ttl: number, nx?: string) => {
      if (nx && seen.has(key)) return null;
      seen.add(key);
      return 'OK';
    }),
  };
  const connection = {
    getSignaturesForAddress: vi
      .fn()
      .mockResolvedValue([
        { signature: 'sig', blockTime: Math.floor(Date.now() / 1000), err: null },
      ]),
    getParsedTransaction: vi.fn().mockResolvedValue(validTx()),
  };
  const prisma = {
    copyTradeConfig: { findMany: vi.fn().mockResolvedValue([{ targetAddress: TARGET }]) },
    wallet: { findMany: vi.fn().mockResolvedValue([]) },
    token: { findUnique: vi.fn().mockResolvedValue({ id: 'token', mint: TOKEN }) },
  };
  const watcher = new CopyTradeWatcher({
    prisma,
    redis,
    connection,
    copyTrading: { mirror },
    dexScreener: { getBestSolanaPair: async () => ({ priceUsd: '1' }) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pollIntervalMs: 15_000,
    maxSignalAgeMs: 120_000,
    minSourceBuySol: 0.01,
  } as never);
  return { watcher, mirror, connection, prisma, redis };
}

describe('copy watcher integration', () => {
  it('mirrors a fresh confirmed buy only once across repeated polls', async () => {
    const f = watcherFixture();
    await f.watcher.tick();
    await f.watcher.tick();
    expect(f.mirror).toHaveBeenCalledTimes(1);
    expect(f.mirror.mock.calls[0]![0]).toMatchObject({ mint: TOKEN, amountSolOriginal: 0.5 });
  });
  it('blocks stale, future, failed, unknown-token and internal-wallet signals', async () => {
    for (const row of [
      { blockTime: 1, err: null },
      { blockTime: Math.floor(Date.now() / 1000) + 60, err: null },
      { blockTime: Math.floor(Date.now() / 1000), err: 'failed' },
    ]) {
      const f = watcherFixture();
      f.connection.getSignaturesForAddress.mockResolvedValue([{ ...row, signature: 'x' }]);
      await f.watcher.tick();
      expect(f.mirror).not.toHaveBeenCalled();
    }
    const f = watcherFixture();
    f.prisma.token.findUnique.mockResolvedValue(null);
    await f.watcher.tick();
    expect(f.mirror).not.toHaveBeenCalled();
    const internal = watcherFixture();
    internal.prisma.wallet.findMany.mockResolvedValue([{ publicKey: TARGET }]);
    await internal.watcher.tick();
    expect(internal.connection.getSignaturesForAddress).not.toHaveBeenCalled();
  });
  it('does not execute if Redis cannot claim the signal', async () => {
    const f = watcherFixture();
    f.redis.set.mockRejectedValue(new Error('redis down'));
    await f.watcher.tick();
    expect(f.mirror).not.toHaveBeenCalled();
  });
});
