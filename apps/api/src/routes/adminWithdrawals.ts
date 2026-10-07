import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminUser } from '../lib/adminAccess.js';

const idParams = z.object({ id: z.string().min(1) });
const rejectBody = z.object({ reason: z.string().trim().min(1).max(500) });
const settingsBody = z.object({
  minWithdrawalUsd: z.number().positive().max(1_000_000),
  maxWithdrawalUsd: z.number().positive().max(100_000_000),
  dailyWithdrawalLimitUsd: z.number().positive().max(100_000_000),
});

async function getOrCreateSettings(fastify: FastifyInstance) {
  const existing = await fastify.prisma.withdrawalSettings.findFirst();
  if (existing) return existing;
  return fastify.prisma.withdrawalSettings.create({ data: {} });
}

export default async function adminWithdrawalRoutes(fastify: FastifyInstance) {
  const guard = { preHandler: requireAdminUser };

  fastify.get('/admin/withdrawal-settings', guard, async () => getOrCreateSettings(fastify));

  fastify.put('/admin/withdrawal-settings', guard, async (req, reply) => {
    const body = settingsBody.parse(req.body);
    if (body.maxWithdrawalUsd < body.minWithdrawalUsd) {
      return reply.code(400).send({ error: 'maxWithdrawalUsd must be >= minWithdrawalUsd' });
    }
    if (body.dailyWithdrawalLimitUsd < body.maxWithdrawalUsd) {
      return reply.code(400).send({
        error: 'dailyWithdrawalLimitUsd must be >= maxWithdrawalUsd',
      });
    }
    const current = await getOrCreateSettings(fastify);
    const updated = await fastify.prisma.withdrawalSettings.update({
      where: { id: current.id },
      data: body,
    });
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        action: 'admin.withdrawal_settings_updated',
        metadata: body,
        ip: req.ip,
      },
    });
    return reply.send(updated);
  });

  fastify.post('/admin/withdrawals/:id/review', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const now = new Date();
    const changed = await fastify.prisma.withdrawalRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'UNDER_REVIEW',
        reviewedByUserId: req.user.userId,
        reviewedAt: now,
      },
    });
    if (changed.count !== 1) {
      const current = await fastify.prisma.withdrawalRequest.findUnique({ where: { id } });
      if (!current) return reply.code(404).send({ error: 'Withdrawal request not found' });
      return reply.code(409).send({ error: `Cannot review withdrawal in status ${current.status}` });
    }
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        action: 'admin.withdrawal_under_review',
        metadata: { withdrawalRequestId: id },
        ip: req.ip,
      },
    });
    return reply.send({ ok: true, status: 'UNDER_REVIEW' });
  });

  fastify.post('/admin/withdrawals/:id/approve', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const now = new Date();
    const changed = await fastify.prisma.withdrawalRequest.updateMany({
      where: { id, status: { in: ['PENDING', 'UNDER_REVIEW'] } },
      data: {
        status: 'APPROVED',
        reviewedByUserId: req.user.userId,
        reviewedAt: now,
        approvedAt: now,
      },
    });
    if (changed.count !== 1) {
      const current = await fastify.prisma.withdrawalRequest.findUnique({ where: { id } });
      if (!current) return reply.code(404).send({ error: 'Withdrawal request not found' });
      return reply.code(409).send({ error: `Cannot approve withdrawal in status ${current.status}` });
    }
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        action: 'admin.withdrawal_approved',
        metadata: {
          withdrawalRequestId: id,
          note: 'Approval does not itself broadcast a Solana transfer',
        },
        ip: req.ip,
      },
    });
    return reply.send({
      ok: true,
      status: 'APPROVED',
      execution: 'awaiting_separate_on_chain_executor',
    });
  });

  fastify.post('/admin/withdrawals/:id/reject', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { reason } = rejectBody.parse(req.body);
    const now = new Date();

    const result = await fastify.prisma.$transaction(async (tx) => {
      const request = await tx.withdrawalRequest.findUnique({ where: { id } });
      if (!request) return { kind: 'not_found' as const };
      if (!['PENDING', 'UNDER_REVIEW', 'APPROVED'].includes(request.status)) {
        return { kind: 'conflict' as const, status: request.status };
      }

      const changed = await tx.withdrawalRequest.updateMany({
        where: { id, status: request.status },
        data: {
          status: 'REJECTED',
          rejectionReason: reason,
          reviewedByUserId: req.user.userId,
          reviewedAt: now,
        },
      });
      if (changed.count !== 1) return { kind: 'race' as const };

      await tx.userDistributionBalance.upsert({
        where: { userId: request.userId },
        create: {
          userId: request.userId,
          withdrawableBalanceUsd: request.amountUsd,
        },
        update: {
          withdrawableBalanceUsd: { increment: request.amountUsd },
        },
      });

      await tx.ledgerEntry.create({
        data: {
          userId: request.userId,
          walletId: request.walletId,
          type: 'WITHDRAW_REJECTED',
          asset: 'USD',
          direction: 'CREDIT',
          amountUsd: request.amountUsd,
          referenceType: 'withdrawal_request',
          referenceId: request.id,
          metadata: { reason, reviewedByUserId: req.user.userId },
        },
      });

      await tx.auditLog.create({
        data: {
          userId: req.user.userId,
          walletId: request.walletId,
          action: 'admin.withdrawal_rejected',
          metadata: {
            withdrawalRequestId: request.id,
            targetUserId: request.userId,
            amountUsd: request.amountUsd,
            reason,
            refundedToWithdrawableBalance: true,
          },
          ip: req.ip,
        },
      });
      return { kind: 'ok' as const, amountUsd: request.amountUsd };
    });

    if (result.kind === 'not_found') {
      return reply.code(404).send({ error: 'Withdrawal request not found' });
    }
    if (result.kind === 'conflict') {
      return reply.code(409).send({
        error: `Cannot reject withdrawal in status ${result.status}`,
      });
    }
    if (result.kind === 'race') {
      return reply.code(409).send({ error: 'Withdrawal changed concurrently; refresh and retry' });
    }
    return reply.send({
      ok: true,
      status: 'REJECTED',
      refundedUsd: result.amountUsd,
    });
  });
}
