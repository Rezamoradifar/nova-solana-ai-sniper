import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { sealKeypair } from '@nova/shared';
import { purchasePlan } from './planPurchase.js';

const KEY = 'a'.repeat(64);
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const treasury = Keypair.generate().publicKey.toBase58();

function setup(
  balanceLamports: number,
  plan: Record<string, unknown> | null = {
    key: 'pro',
    active: true,
    priceSol: 1.5,
    durationDays: 30,
  },
) {
  const sealed = sealKeypair(Keypair.generate(), KEY);
  const prisma = {
    subscriptionPlan: { findUnique: vi.fn().mockResolvedValue(plan) },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'u1', planKey: 'free', planExpiresAt: null }),
      update: vi.fn().mockReturnValue('u'),
    },
    wallet: { findFirst: vi.fn().mockResolvedValue({ id: 'w1', ...sealed }) },
    businessSettings: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 's', treasuryWalletAddress: treasury, performanceFeeBps: 2000 }),
      create: vi.fn(),
    },
    subscription: { create: vi.fn().mockReturnValue('s') },
    $transaction: vi.fn().mockResolvedValue([]),
  };
  const connection = {
    getBalance: vi.fn().mockResolvedValue(balanceLamports),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    sendTransaction: vi.fn().mockResolvedValue('sig'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
  };
  const deps = {
    prisma: prisma as never,
    connection: connection as never,
    logger,
    encryptionKey: KEY,
    minWalletReserveSol: 0.01,
  };
  return { prisma, connection, deps };
}

describe('purchasePlan', () => {
  it('pays the treasury on-chain, then records the subscription and moves the user onto the plan', async () => {
    const { deps, prisma, connection } = setup(2e9);
    const r = await purchasePlan(deps, { userId: 'u1', planKey: 'pro' });
    expect(r.ok).toBe(true);
    expect(connection.sendTransaction).toHaveBeenCalledTimes(1);
    expect(prisma.subscription.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'u1', planKey: 'pro', amountSol: 1.5 }),
      }),
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ planKey: 'pro' }) }),
    );
  });

  it('refuses without sending anything when the wallet cannot cover price + fee + reserve', async () => {
    const { deps, connection } = setup(1.5e9);
    const r = await purchasePlan(deps, { userId: 'u1', planKey: 'pro' });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Insufficient balance/) });
    expect(connection.sendTransaction).not.toHaveBeenCalled();
  });

  it('refuses inactive or free plans', async () => {
    expect((await purchasePlan(setup(5e9, null).deps, { userId: 'u1', planKey: 'x' })).ok).toBe(
      false,
    );
    expect(
      (
        await purchasePlan(
          setup(5e9, { key: 'free', active: true, priceSol: 0, durationDays: 30 }).deps,
          { userId: 'u1', planKey: 'free' },
        )
      ).ok,
    ).toBe(false);
  });

  it('does not record the plan when the payment fails', async () => {
    const { deps, prisma, connection } = setup(2e9);
    connection.confirmTransaction.mockResolvedValue({ value: { err: 'InsufficientFunds' } });
    const r = await purchasePlan(deps, { userId: 'u1', planKey: 'pro' });
    expect(r.ok).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
