import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Connection } from '@solana/web3.js';
import { refreshWalletBalance } from './balanceLedger.js';

function fakeDeps(overrides: {
  lastKnownBalanceLamports?: bigint | null;
  getBalanceResult?: number;
}) {
  const wallet = {
    id: 'wallet-1',
    userId: 'user-1',
    publicKey: '11111111111111111111111111111111',
    isActive: true,
    lastKnownBalanceLamports: overrides.lastKnownBalanceLamports ?? 1_000_000n,
  };
  const walletUpdate = vi.fn().mockResolvedValue(wallet);
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
      findUnique: vi.fn().mockResolvedValue(wallet),
      update: walletUpdate,
    },
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)),
  };
  const getBalance = vi.fn().mockResolvedValue(overrides.getBalanceResult ?? 2_000_000);
  const connection = { getBalance };
  return {
    deps: {
      prisma: prisma as unknown as PrismaClient,
      connection: connection as unknown as Connection,
    },
    getBalance,
    walletUpdate,
    walletUpdateMany,
    ledgerEntryCreate,
  };
}

describe('refreshWalletBalance', () => {
  it('fetches the balance via getBalance when no prefetched value is given', async () => {
    const { deps, getBalance } = fakeDeps({ getBalanceResult: 2_000_000 });

    const result = await refreshWalletBalance(deps, 'wallet-1');

    expect(getBalance).toHaveBeenCalledTimes(1);
    expect(result?.currentLamports).toBe(2_000_000n);
  });

  it('uses prefetchedLamports and skips the getBalance RPC call entirely (2026-07-15 Helius credit audit)', async () => {
    const { deps, getBalance, walletUpdateMany, ledgerEntryCreate } = fakeDeps({});

    const result = await refreshWalletBalance(deps, 'wallet-1', {
      source: 'deposit_monitor',
      prefetchedLamports: 3_000_000n,
    });

    expect(getBalance).not.toHaveBeenCalled();
    expect(result?.currentLamports).toBe(3_000_000n);
    // Still goes through the exact same diff/ledger-write path as the
    // non-prefetched case — this only swaps out where `lamports` comes from.
    expect(walletUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wallet-1', lastKnownBalanceLamports: 1_000_000n },
        data: expect.objectContaining({ lastKnownBalanceLamports: 3_000_000n }),
      }),
    );
    expect(ledgerEntryCreate).toHaveBeenCalledTimes(1);
  });

  it('treats a prefetched balance of 0 as a real value, not "no prefetch given"', async () => {
    // 0n is falsy but must still short-circuit getBalance — regression guard
    // against a naive `opts?.prefetchedLamports ||` instead of `??`.
    const { deps, getBalance } = fakeDeps({ lastKnownBalanceLamports: 5_000_000n });

    const result = await refreshWalletBalance(deps, 'wallet-1', {
      prefetchedLamports: 0n,
    });

    expect(getBalance).not.toHaveBeenCalled();
    expect(result?.currentLamports).toBe(0n);
  });
});
