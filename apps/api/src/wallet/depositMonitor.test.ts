import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Connection } from '@solana/web3.js';
import { DepositMonitor } from './depositMonitor.js';

function fakeWallet(id: string, lamports: bigint) {
  return {
    id,
    userId: `user-${id}`,
    publicKey: '11111111111111111111111111111111',
    isActive: true,
    lastKnownBalanceLamports: lamports,
  };
}

function fakeDeps(wallets: ReturnType<typeof fakeWallet>[], getMultipleAccountsInfoImpl?: unknown) {
  const walletUpdate = vi.fn().mockResolvedValue(undefined);
  const walletUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const ledgerEntryCreate = vi.fn().mockResolvedValue({ id: 'ledger-1' });
  const auditLogCreate = vi.fn().mockResolvedValue({ id: 'audit-1' });
  const tx = {
    wallet: { updateMany: walletUpdateMany },
    ledgerEntry: { create: ledgerEntryCreate },
    auditLog: { create: auditLogCreate },
  };
  const prisma = {
    wallet: {
      findMany: vi.fn().mockResolvedValue(wallets),
      findUnique: vi.fn((args: { where: { id: string } }) =>
        Promise.resolve(wallets.find((w) => w.id === args.where.id)),
      ),
      update: walletUpdate,
    },
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)),
  };
  const getMultipleAccountsInfo =
    getMultipleAccountsInfoImpl ??
    vi.fn().mockResolvedValue(wallets.map(() => ({ lamports: 5_000_000 })));
  const getBalance = vi.fn().mockResolvedValue(0);
  const connection = { getMultipleAccountsInfo, getBalance };
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    deps: {
      prisma: prisma as unknown as PrismaClient,
      connection: connection as unknown as Connection,
      logger: logger as never,
    },
    getMultipleAccountsInfo: getMultipleAccountsInfo as ReturnType<typeof vi.fn>,
    getBalance,
    walletUpdateMany,
    ledgerEntryCreate,
    logger,
  };
}

describe('DepositMonitor.tick', () => {
  it('reads every active wallet balance with a single batched call, not one getBalance per wallet (2026-07-15 Helius credit audit)', async () => {
    const wallets = [
      fakeWallet('w1', 1_000_000n),
      fakeWallet('w2', 1_000_000n),
      fakeWallet('w3', 1_000_000n),
    ];
    const { deps, getMultipleAccountsInfo, getBalance } = fakeDeps(wallets);
    const monitor = new DepositMonitor(deps);

    await monitor.tick();

    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    expect(getBalance).not.toHaveBeenCalled();
    const [pubkeys] = getMultipleAccountsInfo.mock.calls[0]!;
    expect(pubkeys).toHaveLength(3);
  });

  it('chunks batches at 100 wallets per getMultipleAccountsInfo call', async () => {
    const wallets = Array.from({ length: 150 }, (_, i) => fakeWallet(`w${i}`, 1_000_000n));
    const { deps, getMultipleAccountsInfo } = fakeDeps(
      wallets,
      vi
        .fn()
        .mockImplementation((pubkeys: unknown[]) =>
          Promise.resolve(pubkeys.map(() => ({ lamports: 1_000_000 }))),
        ),
    );
    const monitor = new DepositMonitor(deps);

    await monitor.tick();

    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
    expect(getMultipleAccountsInfo.mock.calls[0]![0]).toHaveLength(100);
    expect(getMultipleAccountsInfo.mock.calls[1]![0]).toHaveLength(50);
  });

  it('records a deposit when the batched balance shows an increase, same as the old per-wallet path', async () => {
    const wallets = [fakeWallet('w1', 1_000_000n)];
    const { deps, walletUpdateMany, ledgerEntryCreate } = fakeDeps(
      wallets,
      vi.fn().mockResolvedValue([{ lamports: 4_000_000 }]),
    );
    const monitor = new DepositMonitor(deps);

    await monitor.tick();

    expect(walletUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'w1', lastKnownBalanceLamports: 1_000_000n },
        data: expect.objectContaining({ lastKnownBalanceLamports: 4_000_000n }),
      }),
    );
    expect(ledgerEntryCreate).toHaveBeenCalledTimes(1);
  });

  it('treats a null account (unfunded wallet) as a 0 balance rather than throwing', async () => {
    const wallets = [fakeWallet('w1', 1_000_000n)];
    const { deps, logger } = fakeDeps(wallets, vi.fn().mockResolvedValue([null]));
    const monitor = new DepositMonitor(deps);

    await expect(monitor.tick()).resolves.not.toThrow();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('skips wallets in a chunk whose batched read failed, and does not crash the whole tick', async () => {
    const wallets = [fakeWallet('w1', 1_000_000n)];
    const { deps, logger } = fakeDeps(
      wallets,
      vi.fn().mockRejectedValue(new Error('429 Too Many Requests')),
    );
    const monitor = new DepositMonitor(deps);

    await expect(monitor.tick()).resolves.not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ walletIds: ['w1'] }),
      expect.stringContaining('batched deposit balance read failed'),
    );
  });
});
