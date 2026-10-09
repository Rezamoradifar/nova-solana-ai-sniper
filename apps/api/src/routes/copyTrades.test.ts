import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import copyRoutes, { createCopySchema } from './copyTrades.js';
const target = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
async function fixture() {
  const app = Fastify();
  const prisma = {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ isSuspended: false, deletedAt: null, wallets: [{ id: 'w' }] }),
    },
    wallet: { findFirst: vi.fn().mockResolvedValue(null) },
    copyTradeConfig: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue({ id: 'cfg', userId: 'mine' }),
      create: vi.fn().mockImplementation(async (args) => ({ id: 'new', ...args.data })),
      update: vi.fn().mockResolvedValue({ isActive: false }),
    },
  };
  app.decorate('prisma', prisma as never);
  app.decorate('config', { COPY_TRADING_MAX_BUY_SOL: 0.1 } as never);
  app.decorate('authenticate', async (req: { user: unknown }) => {
    req.user = { userId: 'mine' };
  });
  await app.register(copyRoutes);
  return { app, prisma };
}
describe('copy account API', () => {
  it('validates actual public keys and defaults to bounded sizes', () => {
    expect(createCopySchema.safeParse({ targetAddress: 'x'.repeat(44) }).success).toBe(false);
    expect(
      createCopySchema.safeParse({ targetAddress: target, maxAmountSol: Infinity }).success,
    ).toBe(false);
    expect(createCopySchema.parse({ targetAddress: target })).toMatchObject({
      maxAmountSol: 0.1,
      copyPercentSize: 25,
    });
  });
  it('caps create requests on the server', async () => {
    const { app } = await fixture();
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/copy-trades',
        payload: { targetAddress: target, maxAmountSol: 5 },
      });
      expect(r.statusCode).toBe(201);
      expect(r.json().maxAmountSol).toBe(0.1);
    } finally {
      await app.close();
    }
  });
  it('rejects suspended accounts and internal targets', async () => {
    const { app, prisma } = await fixture();
    try {
      prisma.user.findUnique.mockResolvedValue({
        isSuspended: true,
        deletedAt: null,
        wallets: [{ id: 'w' }],
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/copy-trades',
            payload: { targetAddress: target },
          })
        ).statusCode,
      ).toBe(409);
      prisma.user.findUnique.mockResolvedValue({
        isSuspended: false,
        deletedAt: null,
        wallets: [{ id: 'w' }],
      });
      prisma.wallet.findFirst.mockResolvedValue({ id: 'internal' });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/copy-trades',
            payload: { targetAddress: target },
          })
        ).statusCode,
      ).toBe(400);
      expect(prisma.copyTradeConfig.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('does not let a user pause another account copy config', async () => {
    const { app, prisma } = await fixture();
    prisma.copyTradeConfig.findUnique.mockResolvedValue({ id: 'cfg', userId: 'someone-else' });
    try {
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/copy-trades/cfg/status',
            payload: { enabled: false },
          })
        ).statusCode,
      ).toBe(404);
      expect(prisma.copyTradeConfig.update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
