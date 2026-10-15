import Fastify, { type FastifyRequest } from 'fastify';
import jwt from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import executions from './executions.js';
async function setup(role = 'USER') {
  const app = Fastify();
  await app.register(jwt, { secret: 'execution-report-tests-only-secret' });
  app.decorate('authenticate', async (req: FastifyRequest) => {
    await req.jwtVerify();
  });
  const prisma = {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ role, telegramId: null, isSuspended: false, deletedAt: null }),
    },
    trade: {
      count: vi.fn().mockResolvedValue(50),
      findFirst: vi.fn().mockResolvedValue({ id: 'cursor' }),
      findMany: vi
        .fn()
        .mockResolvedValue(Array.from({ length: 26 }, (_, i) => ({ id: `trade-${i}` }))),
    },
    position: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { realizedPnlUsd: 42 }, _count: 7 }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  app.decorate('config', {} as never);
  app.decorate('prisma', prisma as never);
  await app.register(executions);
  const headers = { authorization: `Bearer ${app.jwt.sign({ userId: 'owner', role: 'TRADER' })}` };
  return { app, prisma, headers };
}
describe('execution reporting access and data boundaries', () => {
  it('requires authentication and validates report filters', async () => {
    const { app, headers } = await setup();
    try {
      expect((await app.inject('/executions')).statusCode).toBe(401);
      expect((await app.inject({ url: '/executions?limit=999', headers })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('returns only owned confirmed live executions and paginates beyond 100', async () => {
    const { app, prisma, headers } = await setup();
    try {
      const r = await app.inject({ url: '/executions', headers });
      expect(r.statusCode).toBe(200);
      expect(r.json().rows).toHaveLength(25);
      expect(r.json().nextCursor).toBe('trade-24');
      expect(prisma.trade.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { wallet: { userId: 'owner' }, isPaperTrade: false, status: 'CONFIRMED' },
          take: 26,
          select: expect.objectContaining({ wallet: { select: { label: true, publicKey: true } } }),
        }),
      );
      expect(r.json().summary).toMatchObject({ realizedPnlUsd: 42, closedPositions: 7 });
      const cursor = await app.inject({ url: '/executions?cursor=cursor', headers });
      expect(cursor.statusCode).toBe(200);
      expect(prisma.trade.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ wallet: { userId: 'owner' }, id: 'cursor' }),
        }),
      );
      expect(prisma.trade.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: { id: 'cursor' }, skip: 1 }),
      );
    } finally {
      await app.close();
    }
  });
  it('separates paper results and rejects foreign cursors', async () => {
    const { app, prisma, headers } = await setup();
    try {
      const r = await app.inject({ url: '/executions?view=positions&mode=paper', headers });
      expect(r.statusCode).toBe(200);
      expect(prisma.position.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { wallet: { userId: 'owner' }, isPaperTrade: true, status: 'CLOSED' },
        }),
      );
      expect(
        (await app.inject({ url: '/executions?view=positions&cursor=foreign', headers }))
          .statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('forbids a non-admin from querying all accounts before any financial query', async () => {
    const { app, prisma, headers } = await setup();
    try {
      expect((await app.inject({ url: '/executions?scope=all', headers })).statusCode).toBe(403);
      expect(prisma.trade.count).not.toHaveBeenCalled();
      expect(prisma.position.aggregate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('allows verified admins to view all executions', async () => {
    const { app, prisma, headers } = await setup('ADMIN');
    try {
      expect((await app.inject({ url: '/executions?scope=all', headers })).statusCode).toBe(200);
      expect(prisma.trade.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { wallet: {}, isPaperTrade: false, status: 'CONFIRMED' },
        }),
      );
    } finally {
      await app.close();
    }
  });
});
