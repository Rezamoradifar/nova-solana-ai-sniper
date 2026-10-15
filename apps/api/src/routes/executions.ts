import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminUser } from '../lib/adminAccess.js';
const querySchema = z.object({
  mode: z.enum(['live', 'paper']).default('live'),
  scope: z.enum(['mine', 'all']).default('mine'),
  view: z.enum(['trades', 'positions']).default('trades'),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(64).optional(),
});
export default async function executionRoutes(app: FastifyInstance) {
  app.get('/executions', { preHandler: app.authenticate }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid report filters' });
    const q = parsed.data;
    if (q.scope === 'all') {
      await requireAdminUser(req, reply);
      if (reply.sent) return;
    }
    const wallet = q.scope === 'all' ? {} : { userId: req.user.userId };
    const mode = { wallet, isPaperTrade: q.mode === 'paper' };
    const token = { select: { mint: true, symbol: true, name: true } };
    const owner = { select: { label: true, publicKey: true } };
    const [confirmedTrades, pnl] = await Promise.all([
      app.prisma.trade.count({ where: { ...mode, status: 'CONFIRMED' } }),
      app.prisma.position.aggregate({
        where: { ...mode, status: 'CLOSED' },
        _sum: { realizedPnlUsd: true },
        _count: true,
      }),
    ]);
    const summary = {
      confirmedTrades,
      closedPositions: pnl._count,
      realizedPnlUsd: pnl._sum.realizedPnlUsd,
    };
    if (q.view === 'trades') {
      const where = { ...mode, status: 'CONFIRMED' as const };
      if (
        q.cursor &&
        !(await app.prisma.trade.findFirst({
          where: { ...where, id: q.cursor },
          select: { id: true },
        }))
      )
        return reply.code(400).send({ error: 'Invalid report cursor' });
      const rows = await app.prisma.trade.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          side: true,
          status: true,
          amountSol: true,
          amountToken: true,
          priceUsd: true,
          txSignature: true,
          isPaperTrade: true,
          createdAt: true,
          confirmedAt: true,
          token,
          wallet: owner,
        },
      });
      return {
        mode: q.mode,
        scope: q.scope,
        view: q.view,
        summary,
        rows: rows.slice(0, q.limit),
        nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
      };
    }
    const where = { ...mode, status: 'CLOSED' as const };
    if (
      q.cursor &&
      !(await app.prisma.position.findFirst({
        where: { ...where, id: q.cursor },
        select: { id: true },
      }))
    )
      return reply.code(400).send({ error: 'Invalid report cursor' });
    const rows = await app.prisma.position.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        realizedPnlUsd: true,
        amountSolInvested: true,
        entryPriceUsd: true,
        copyTradeTargetAddress: true,
        isPaperTrade: true,
        createdAt: true,
        closedAt: true,
        token,
        wallet: owner,
      },
    });
    return {
      mode: q.mode,
      scope: q.scope,
      view: q.view,
      summary,
      rows: rows.slice(0, q.limit),
      nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
    };
  });
}
