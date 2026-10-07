import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminUser } from '../lib/adminAccess.js';

const idParams = z.object({ id: z.string().min(1) });
const suspendBody = z.object({ reason: z.string().trim().min(1).max(500).optional() });
const roleBody = z.object({ role: z.enum(['ADMIN', 'TRADER']) });
const planBody = z.object({ planKey: z.string().min(1).max(40) });
const deleteQuery = z.object({ confirm: z.literal('DELETE') });

export default async function adminUserRoutes(fastify: FastifyInstance) {
  const guard = { preHandler: requireAdminUser };

  fastify.get('/admin/users/:id', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const user = await fastify.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        telegramId: true,
        role: true,
        language: true,
        planKey: true,
        planExpiresAt: true,
        subscriptionTier: true,
        referralCode: true,
        referredByCode: true,
        telegramActive: true,
        isSuspended: true,
        suspendedAt: true,
        suspensionReason: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
        wallets: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            label: true,
            publicKey: true,
            isActive: true,
            lastKnownBalanceLamports: true,
            balanceUpdatedAt: true,
            createdAt: true,
            _count: { select: { positions: true, trades: true, ledgerEntries: true } },
          },
        },
        snipeConfigs: { orderBy: { createdAt: 'desc' } },
        copyConfigs: { orderBy: { createdAt: 'desc' } },
        subscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            planKey: true,
            amountSol: true,
            txSignature: true,
            startsAt: true,
            expiresAt: true,
            createdAt: true,
          },
        },
      },
    });
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const [ledger, audit, fees, rewardsEarned, rewardsCaused, withdrawalRequests] = await Promise.all([
      fastify.prisma.ledgerEntry.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      fastify.prisma.auditLog.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      fastify.prisma.performanceFeeLedger.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      fastify.prisma.referralReward.findMany({
        where: { referrerUserId: id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      fastify.prisma.referralReward.findMany({
        where: { referredUserId: id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      fastify.prisma.withdrawalRequest.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    ]);

    return {
      ...user,
      wallets: user.wallets.map((w) => ({
        ...w,
        lastKnownBalanceLamports: w.lastKnownBalanceLamports?.toString() ?? null,
      })),
      ledger: ledger.map((row) => ({
        ...row,
        amountLamports: row.amountLamports?.toString() ?? null,
        balanceAfterLamports: row.balanceAfterLamports?.toString() ?? null,
      })),
      audit,
      fees,
      rewardsEarned,
      rewardsCaused,
      withdrawalRequests,
    };
  });

  fastify.post('/admin/users/:id/suspend', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { reason } = suspendBody.parse(req.body ?? {});
    if (id === req.user.userId) {
      return reply.code(400).send({ error: 'You cannot suspend your own admin account' });
    }
    const target = await fastify.prisma.user.findUnique({
      where: { id },
      select: { id: true, deletedAt: true, isSuspended: true },
    });
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.deletedAt) return reply.code(409).send({ error: 'Deleted accounts cannot be suspended' });

    const now = new Date();
    const result = await fastify.prisma.$transaction(async (tx) => {
      const [snipes, copies] = await Promise.all([
        tx.snipeConfig.updateMany({
          where: { userId: id },
          data: { isActive: false, autoBuyOnLaunch: false },
        }),
        tx.copyTradeConfig.updateMany({
          where: { userId: id },
          data: { isActive: false },
        }),
      ]);
      await tx.user.update({
        where: { id },
        data: {
          isSuspended: true,
          suspendedAt: now,
          suspensionReason: reason ?? 'Suspended by administrator',
        },
      });
      await tx.auditLog.create({
        data: {
          userId: req.user.userId,
          action: 'admin.user_suspended',
          metadata: { targetUserId: id, reason: reason ?? null, snipesPaused: snipes.count, copyPaused: copies.count },
          ip: req.ip,
        },
      });
      return { snipesPaused: snipes.count, copyPaused: copies.count };
    });

    return reply.send({ ok: true, ...result });
  });

  fastify.post('/admin/users/:id/resume', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const target = await fastify.prisma.user.findUnique({
      where: { id },
      select: { id: true, deletedAt: true },
    });
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.deletedAt) {
      return reply.code(409).send({ error: 'Deleted accounts cannot be resumed' });
    }
    await fastify.prisma.$transaction([
      fastify.prisma.user.update({
        where: { id },
        data: { isSuspended: false, suspendedAt: null, suspensionReason: null },
      }),
      fastify.prisma.auditLog.create({
        data: {
          userId: req.user.userId,
          action: 'admin.user_resumed',
          metadata: { targetUserId: id, note: 'Trading configs remain paused until explicitly enabled' },
          ip: req.ip,
        },
      }),
    ]);
    return reply.send({ ok: true, tradingConfigsRemainPaused: true });
  });

  fastify.put('/admin/users/:id/role', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { role } = roleBody.parse(req.body);
    if (id === req.user.userId && role !== 'ADMIN') {
      return reply.code(400).send({ error: 'You cannot remove your own admin role' });
    }
    const target = await fastify.prisma.user.findUnique({
      where: { id },
      select: { id: true, deletedAt: true },
    });
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.deletedAt) return reply.code(409).send({ error: 'Deleted account cannot change role' });
    await fastify.prisma.$transaction([
      fastify.prisma.user.update({ where: { id }, data: { role } }),
      fastify.prisma.auditLog.create({
        data: {
          userId: req.user.userId,
          action: 'admin.user_role_changed',
          metadata: { targetUserId: id, role },
          ip: req.ip,
        },
      }),
    ]);
    return reply.send({ ok: true, role });
  });

  fastify.put('/admin/users/:id/plan', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { planKey } = planBody.parse(req.body);
    const [target, plan] = await Promise.all([
      fastify.prisma.user.findUnique({ where: { id }, select: { id: true, deletedAt: true } }),
      fastify.prisma.subscriptionPlan.findUnique({ where: { key: planKey } }),
    ]);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.deletedAt) return reply.code(409).send({ error: 'Deleted account cannot change plan' });
    if (!plan) return reply.code(404).send({ error: 'Plan not found' });

    const expiresAt =
      planKey === 'free' ? null : new Date(Date.now() + plan.durationDays * 86_400_000);
    await fastify.prisma.$transaction([
      fastify.prisma.user.update({ where: { id }, data: { planKey, planExpiresAt: expiresAt } }),
      fastify.prisma.auditLog.create({
        data: {
          userId: req.user.userId,
          action: 'admin.user_plan_changed',
          metadata: { targetUserId: id, planKey, expiresAt, complimentary: true },
          ip: req.ip,
        },
      }),
    ]);
    return reply.send({ ok: true, planKey, expiresAt });
  });

  fastify.delete('/admin/users/:id', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    deleteQuery.parse(req.query);
    if (id === req.user.userId) {
      return reply.code(400).send({ error: 'You cannot delete your own admin account' });
    }

    const target = await fastify.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        role: true,
        deletedAt: true,
        _count: {
          select: {
            wallets: true,
            ledgerEntries: true,
            performanceFees: true,
            referralRewardsEarned: true,
            referralRewardsCaused: true,
          },
        },
      },
    });
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.deletedAt) return reply.send({ ok: true, alreadyDeleted: true });

    const blockers = {
      wallets: target._count.wallets,
      ledgerEntries: target._count.ledgerEntries,
      performanceFees: target._count.performanceFees,
      referralRewards:
        target._count.referralRewardsEarned + target._count.referralRewardsCaused,
    };
    if (Object.values(blockers).some((value) => value > 0)) {
      return reply.code(409).send({
        error:
          'This account has wallet or financial history and cannot be deleted. Suspend it instead so funds and audit records remain recoverable.',
        blockers,
      });
    }

    const now = new Date();
    await fastify.prisma.$transaction(async (tx) => {
      await Promise.all([
        tx.snipeConfig.updateMany({
          where: { userId: id },
          data: { isActive: false, autoBuyOnLaunch: false },
        }),
        tx.copyTradeConfig.updateMany({ where: { userId: id }, data: { isActive: false } }),
        tx.watchlistItem.deleteMany({ where: { userId: id } }),
        tx.tradeBroadcastDelivery.deleteMany({ where: { userId: id, status: 'PENDING' } }),
        tx.adminBroadcastDelivery.deleteMany({ where: { userId: id, status: 'PENDING' } }),
        tx.networkTradeBroadcastDelivery.deleteMany({ where: { userId: id, status: 'PENDING' } }),
      ]);
      await tx.user.update({
        where: { id },
        data: {
          email: null,
          telegramId: null,
          passwordHash: null,
          referralCode: null,
          referredByCode: null,
          planKey: 'free',
          planExpiresAt: null,
          feePolicyAcceptedAt: null,
          feePolicyAcceptedFeeBps: null,
          telegramActive: false,
          isSuspended: true,
          suspendedAt: now,
          suspensionReason: 'Deleted by administrator',
          deletedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: req.user.userId,
          action: 'admin.user_deleted',
          metadata: { targetUserId: id, method: 'anonymized_soft_delete' },
          ip: req.ip,
        },
      });
    });

    return reply.send({ ok: true, deletedAt: now, method: 'anonymized_soft_delete' });
  });
}
