import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { refreshWalletBalance } from '@nova/shared';
import { requireAdminUser } from '../lib/adminAccess.js';

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(120).optional(),
});
const idParams = z.object({ id: z.string().min(1) });
const flagBody = z.object({ enabled: z.boolean() });
const copyCreateBody = z.object({
  targetAddress: z.string().min(32).max(44),
  copyPercentSize: z.number().positive().max(100).default(100),
  maxAmountSol: z.number().positive().max(1000).nullable().optional(),
});
const blacklistBody = z.object({
  type: z.enum(['MINT', 'DEPLOYER']),
  value: z.string().trim().min(20).max(100),
  reason: z.string().trim().max(500).optional(),
});
const broadcastBody = z.object({
  text: z.string().trim().min(1).max(4000),
});

const CHUNK_SIZE = 5000;
function chunk<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < rows.length; i += size) result.push(rows.slice(i, i + size));
  return result;
}

export default async function adminOperationsRoutes(fastify: FastifyInstance) {
  const guard = { preHandler: requireAdminUser };

  // -------------------------------------------------------------------------
  // Wallet management
  // -------------------------------------------------------------------------
  fastify.get('/admin/wallets', guard, async (req) => {
    const { limit, offset, search } = pageQuery.parse(req.query);
    const where = search
      ? {
          OR: [
            { publicKey: { contains: search } },
            { label: { contains: search, mode: 'insensitive' as const } },
            { user: { email: { contains: search, mode: 'insensitive' as const } } },
            { user: { telegramId: { contains: search } } },
          ],
        }
      : {};
    const [total, rows] = await Promise.all([
      fastify.prisma.wallet.count({ where }),
      fastify.prisma.wallet.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          label: true,
          publicKey: true,
          isActive: true,
          lastKnownBalanceLamports: true,
          balanceUpdatedAt: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              email: true,
              telegramId: true,
              isSuspended: true,
              deletedAt: true,
            },
          },
          _count: { select: { positions: true, trades: true, ledgerEntries: true } },
        },
      }),
    ]);
    return {
      total,
      rows: rows.map((row) => ({
        ...row,
        lastKnownBalanceLamports: row.lastKnownBalanceLamports?.toString() ?? null,
      })),
    };
  });

  fastify.put('/admin/wallets/:id/status', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { enabled } = flagBody.parse(req.body);
    const wallet = await fastify.prisma.wallet.findUnique({
      where: { id },
      select: { id: true, userId: true, isActive: true },
    });
    if (!wallet) return reply.code(404).send({ error: 'Wallet not found' });
    if (!enabled) {
      const openPositions = await fastify.prisma.position.count({
        where: { walletId: id, status: 'OPEN' },
      });
      if (openPositions > 0) {
        return reply.code(409).send({
          error: 'Wallet has open positions and cannot be disabled until they are closed',
          openPositions,
        });
      }
    }
    await fastify.prisma.$transaction([
      fastify.prisma.wallet.update({ where: { id }, data: { isActive: enabled } }),
      fastify.prisma.auditLog.create({
        data: {
          userId: req.user.userId,
          walletId: id,
          action: enabled ? 'admin.wallet_enabled' : 'admin.wallet_disabled',
          metadata: { targetUserId: wallet.userId },
          ip: req.ip,
        },
      }),
    ]);
    return reply.send({ ok: true, enabled });
  });

  fastify.post('/admin/wallets/:id/refresh-balance', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    if (!fastify.solanaConnection) {
      return reply.code(503).send({ error: 'Solana RPC connection not available' });
    }
    const result = await refreshWalletBalance(
      {
        prisma: fastify.prisma,
        connection: fastify.solanaConnection,
        logger: fastify.log as never,
      },
      id,
      { ip: req.ip, source: 'refresh_endpoint' },
    );
    if (!result) return reply.code(404).send({ error: 'Wallet not found or inactive' });
    return reply.send({
      walletId: result.walletId,
      currentLamports: result.currentLamports.toString(),
      previousLamports: result.previousLamports?.toString() ?? null,
      deltaLamports: result.deltaLamports.toString(),
      depositRecorded: Boolean(result.depositLedgerEntryId),
    });
  });

  // -------------------------------------------------------------------------
  // Copy-trade management
  // -------------------------------------------------------------------------
  fastify.post('/admin/users/:id/copy-trades', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = copyCreateBody.parse(req.body);
    const user = await fastify.prisma.user.findUnique({
      where: { id },
      select: { id: true, isSuspended: true, deletedAt: true },
    });
    if (!user) return reply.code(404).send({ error: 'User not found' });
    if (user.deletedAt) return reply.code(409).send({ error: 'Deleted account cannot use copy trading' });
    if (user.isSuspended) return reply.code(409).send({ error: 'Suspended account cannot use copy trading' });

    const created = await fastify.prisma.copyTradeConfig.create({
      data: {
        userId: id,
        targetAddress: body.targetAddress,
        copyPercentSize: body.copyPercentSize,
        maxAmountSol: body.maxAmountSol ?? undefined,
      },
    });
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        action: 'admin.copy_trade_created',
        metadata: { targetUserId: id, copyConfigId: created.id, targetAddress: body.targetAddress },
        ip: req.ip,
      },
    });
    return reply.code(201).send(created);
  });

  fastify.put('/admin/copy-trades/:id/status', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { enabled } = flagBody.parse(req.body);
    const config = await fastify.prisma.copyTradeConfig.findUnique({
      where: { id },
      include: { user: { select: { isSuspended: true, deletedAt: true } } },
    });
    if (!config) return reply.code(404).send({ error: 'Copy trade config not found' });
    if (enabled && (config.user.isSuspended || config.user.deletedAt)) {
      return reply.code(409).send({ error: 'Cannot enable copy trading for suspended/deleted user' });
    }
    await fastify.prisma.$transaction([
      fastify.prisma.copyTradeConfig.update({ where: { id }, data: { isActive: enabled } }),
      fastify.prisma.auditLog.create({
        data: {
          userId: req.user.userId,
          action: 'admin.copy_trade_status',
          metadata: { copyConfigId: id, targetUserId: config.userId, enabled },
          ip: req.ip,
        },
      }),
    ]);
    return reply.send({ ok: true, enabled });
  });

  fastify.delete('/admin/copy-trades/:id', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const config = await fastify.prisma.copyTradeConfig.findUnique({ where: { id } });
    if (!config) return reply.code(404).send({ error: 'Copy trade config not found' });
    await fastify.prisma.$transaction([
      fastify.prisma.copyTradeConfig.delete({ where: { id } }),
      fastify.prisma.auditLog.create({
        data: {
          userId: req.user.userId,
          action: 'admin.copy_trade_deleted',
          metadata: { copyConfigId: id, targetUserId: config.userId, targetAddress: config.targetAddress },
          ip: req.ip,
        },
      }),
    ]);
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // Mint/deployer blacklist
  // -------------------------------------------------------------------------
  fastify.get('/admin/blacklist', guard, async () => {
    return fastify.prisma.blacklistEntry.findMany({ orderBy: { createdAt: 'desc' } });
  });

  fastify.post('/admin/blacklist', guard, async (req, reply) => {
    const body = blacklistBody.parse(req.body);
    const row = await fastify.prisma.blacklistEntry.upsert({
      where: { type_value: { type: body.type, value: body.value } },
      create: body,
      update: { reason: body.reason },
    });
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        action: 'admin.blacklist_upsert',
        metadata: { id: row.id, type: row.type, value: row.value, reason: row.reason },
        ip: req.ip,
      },
    });
    return reply.code(201).send(row);
  });

  fastify.delete('/admin/blacklist/:id', guard, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const row = await fastify.prisma.blacklistEntry.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: 'Blacklist entry not found' });
    await fastify.prisma.$transaction([
      fastify.prisma.blacklistEntry.delete({ where: { id } }),
      fastify.prisma.auditLog.create({
        data: {
          userId: req.user.userId,
          action: 'admin.blacklist_deleted',
          metadata: { type: row.type, value: row.value },
          ip: req.ip,
        },
      }),
    ]);
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // Telegram broadcast management
  // -------------------------------------------------------------------------
  fastify.get('/admin/broadcasts', guard, async (req) => {
    const { limit, offset } = pageQuery.parse(req.query);
    const [total, rows] = await Promise.all([
      fastify.prisma.adminBroadcast.count(),
      fastify.prisma.adminBroadcast.findMany({
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
    ]);
    return { total, rows };
  });

  fastify.post('/admin/broadcasts', guard, async (req, reply) => {
    const { text } = broadcastBody.parse(req.body);
    const recipients = await fastify.prisma.user.findMany({
      where: {
        telegramId: { not: null },
        telegramActive: true,
        isSuspended: false,
        deletedAt: null,
      },
      select: { id: true, telegramId: true },
    });

    const broadcast = await fastify.prisma.adminBroadcast.create({
      data: { text, totalRecipients: recipients.length },
    });
    for (const batch of chunk(recipients, CHUNK_SIZE)) {
      await fastify.prisma.adminBroadcastDelivery.createMany({
        data: batch.map((user) => ({
          broadcastId: broadcast.id,
          userId: user.id,
          telegramChatId: user.telegramId!,
        })),
      });
    }
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        action: 'admin.broadcast_queued',
        metadata: { broadcastId: broadcast.id, recipients: recipients.length },
        ip: req.ip,
      },
    });
    return reply.code(201).send({
      ok: true,
      broadcastId: broadcast.id,
      recipientCount: recipients.length,
    });
  });
}
