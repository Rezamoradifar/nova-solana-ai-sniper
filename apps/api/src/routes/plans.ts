import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { effectivePlanKey, getOrCreateBusinessSettings } from '@nova/shared';
import { requireAdminUser } from '../lib/adminAccess.js';
import { invalidatePlanCache, loadPlans, publicPlan } from '../lib/plans.js';
import { purchasePlan } from '../business/planPurchase.js';

const DAY_MS = 86_400_000;

const purchaseBody = z.object({
  planKey: z.string().min(1).max(40),
  walletId: z.string().optional(),
});
const planUpdateBody = z
  .object({
    name: z.string().min(1).max(40),
    priceSol: z.number().min(0).max(1000),
    durationDays: z.number().int().min(1).max(3650),
    /** Percent of net profit; null = use the global fee. */
    feePercent: z.number().min(0).max(100).nullable(),
    maxBuySol: z.number().positive().max(1000).nullable(),
    maxOpenPositions: z.number().int().positive().max(1000).nullable(),
    autoBuyEnabled: z.boolean(),
    features: z.array(z.string().max(120)).max(12),
    active: z.boolean(),
  })
  .partial();

export default async function planRoutes(fastify: FastifyInstance) {
  // Public: the website's pricing table.
  fastify.get('/public/plans', async () => {
    const [all, settings] = await Promise.all([
      loadPlans(fastify.prisma),
      getOrCreateBusinessSettings(fastify.prisma),
    ]);
    const plans = [...all.values()].filter((p) => p.active);
    return { defaultFeeBps: settings.performanceFeeBps, plans: plans.map(publicPlan) };
  });

  fastify.get('/plans/me', { preHandler: fastify.authenticate }, async (req) => {
    const [user, plans] = await Promise.all([
      fastify.prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { planKey: true, planExpiresAt: true },
      }),
      loadPlans(fastify.prisma),
    ]);
    const current = user ? effectivePlanKey(user) : 'free';
    return {
      currentPlanKey: current,
      expiresAt: current === 'free' ? null : (user?.planExpiresAt ?? null),
      plans: [...plans.values()].filter((p) => p.active).map(publicPlan),
    };
  });

  fastify.post(
    '/plans/purchase',
    { preHandler: fastify.authenticate, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = purchaseBody.parse(req.body);
      if (!fastify.solanaConnection)
        return reply.code(503).send({ error: 'Payments are temporarily unavailable' });
      const result = await purchasePlan(
        {
          prisma: fastify.prisma,
          connection: fastify.solanaConnection,
          logger: req.log as never,
          encryptionKey: fastify.config.ENCRYPTION_KEY,
          envTreasuryAddress: fastify.config.PLATFORM_TREASURY_WALLET_ADDRESS,
          minWalletReserveSol: fastify.config.MIN_WALLET_RESERVE_SOL,
        },
        { userId: req.user.userId, planKey: body.planKey, walletId: body.walletId },
      );
      if (!result.ok) return reply.code(400).send({ error: result.error });
      return result;
    },
  );

  // Owner view: every plan with subscribers and revenue.
  fastify.get('/admin/plans', { preHandler: requireAdminUser }, async () => {
    const prisma = fastify.prisma;
    const now = new Date();
    const since30d = new Date(now.getTime() - 30 * DAY_MS);
    const [plans, activeByPlan, revenueAll, revenue30d, recent, totalUsers] = await Promise.all([
      prisma.subscriptionPlan.findMany({ orderBy: { sortOrder: 'asc' } }),
      prisma.user.groupBy({
        by: ['planKey'],
        _count: { _all: true },
        where: { planKey: { not: 'free' }, planExpiresAt: { gt: now } },
      }),
      prisma.subscription.groupBy({
        by: ['planKey'],
        _sum: { amountSol: true },
        _count: { _all: true },
      }),
      prisma.subscription.groupBy({
        by: ['planKey'],
        _sum: { amountSol: true },
        _count: { _all: true },
        where: { createdAt: { gte: since30d } },
      }),
      prisma.subscription.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { user: { select: { telegramId: true } } },
      }),
      prisma.user.count({ where: { telegramId: { not: null } } }),
    ]);
    const byKey = <T extends { planKey: string }>(rows: T[]) =>
      new Map(rows.map((r) => [r.planKey, r]));
    const active = byKey(activeByPlan);
    const all = byKey(revenueAll);
    const last30 = byKey(revenue30d);
    const paidActive = activeByPlan.reduce((n, r) => n + r._count._all, 0);
    return {
      totals: {
        users: totalUsers,
        paidSubscribers: paidActive,
        freeUsers: Math.max(0, totalUsers - paidActive),
        revenueSol: revenueAll.reduce((s, r) => s + (r._sum.amountSol ?? 0), 0),
        revenue30dSol: revenue30d.reduce((s, r) => s + (r._sum.amountSol ?? 0), 0),
        sales: revenueAll.reduce((n, r) => n + r._count._all, 0),
      },
      plans: plans.map((p) => ({
        ...publicPlan(p),
        active: p.active,
        sortOrder: p.sortOrder,
        activeSubscribers:
          p.key === 'free'
            ? Math.max(0, totalUsers - paidActive)
            : (active.get(p.key)?._count._all ?? 0),
        sales: all.get(p.key)?._count._all ?? 0,
        revenueSol: all.get(p.key)?._sum.amountSol ?? 0,
        sales30d: last30.get(p.key)?._count._all ?? 0,
        revenue30dSol: last30.get(p.key)?._sum.amountSol ?? 0,
      })),
      recent: recent.map((s) => ({
        planKey: s.planKey,
        amountSol: s.amountSol,
        telegramId: s.user.telegramId,
        txSignature: s.txSignature,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
      })),
    };
  });

  fastify.put('/admin/plans/:key', { preHandler: requireAdminUser }, async (req, reply) => {
    const { key } = z.object({ key: z.string().min(1).max(40) }).parse(req.params);
    const body = planUpdateBody.parse(req.body);
    const existing = await fastify.prisma.subscriptionPlan.findUnique({ where: { key } });
    if (!existing) return reply.code(404).send({ error: 'Unknown plan' });
    const { feePercent, features, ...rest } = body;
    const updated = await fastify.prisma.subscriptionPlan.update({
      where: { key },
      data: {
        ...rest,
        ...(feePercent !== undefined
          ? { feeBps: feePercent === null ? null : Math.round(feePercent * 100) }
          : {}),
        ...(features !== undefined ? { features: features.join('\n') } : {}),
      },
    });
    invalidatePlanCache();
    req.log.info({ key, changes: body, by: req.user.userId }, 'plan updated by admin');
    return { ok: true, plan: publicPlan(updated) };
  });
}
