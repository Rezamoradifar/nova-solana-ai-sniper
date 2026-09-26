import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  getKillSwitchState,
  getOrCreateBusinessSettings,
  getScannerAutoBuyPauseReason,
  getScannerAutoBuyPauseState,
  setKillSwitchState,
  setPlatformFee,
  setReferralLevel,
  setReferralProgramEnabled,
  setScannerAutoBuyPauseState,
  setTreasuryWallet,
} from '@nova/shared';
import { requireAdminUser } from '../lib/adminAccess.js';
import {
  computePerformance,
  INVALID_PAPER_HOLD_MS,
  type ClosedPositionResult,
} from '../lib/performance.js';

const percentBody = z.object({ percent: z.number().min(0).max(100) });
const treasuryBody = z.object({ address: z.string().min(1).max(100) });
const flagBody = z.object({ enabled: z.boolean() });
const levelParams = z.object({ level: z.coerce.number().int().min(1).max(10) });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Admin-only endpoints behind the Mini App's Admin tab. Every write goes
 * through the same @nova/shared helpers as the bot's /admin panel, so both
 * enforce identical rules and write the same audit log entries.
 */
export default async function adminRoutes(fastify: FastifyInstance) {
  const guard = { preHandler: requireAdminUser };
  const actorOf = (userId: string) => ({ userId });

  async function sendResult(reply: FastifyReply, error: string | undefined) {
    if (error) return reply.code(400).send({ error });
    return reply.send({ ok: true });
  }

  fastify.get('/admin/overview', guard, async () => {
    const prisma = fastify.prisma;
    const since24h = new Date(Date.now() - DAY_MS);
    const since10m = new Date(Date.now() - 10 * 60 * 1000);

    const [
      settings,
      killSwitch,
      autoBuyPaused,
      autoBuyPausedReason,
      users,
      newUsers24h,
      openPositions,
      trades24h,
      totalTrades,
      volume24h,
      volumeTotal,
      feeRevenue,
      referralPaid,
      activeSnipeConfigs,
      tokens10m,
      tokens24h,
    ] = await Promise.all([
      getOrCreateBusinessSettings(prisma),
      getKillSwitchState(fastify.redis),
      getScannerAutoBuyPauseState(fastify.redis),
      getScannerAutoBuyPauseReason(fastify.redis),
      prisma.user.count({ where: { telegramId: { not: null } } }),
      prisma.user.count({ where: { telegramId: { not: null }, createdAt: { gte: since24h } } }),
      prisma.position.count({ where: { status: 'OPEN' } }),
      prisma.trade.count({ where: { status: 'CONFIRMED', createdAt: { gte: since24h } } }),
      prisma.trade.count({ where: { status: 'CONFIRMED' } }),
      prisma.trade.aggregate({
        _sum: { amountSol: true },
        where: { status: 'CONFIRMED', createdAt: { gte: since24h } },
      }),
      prisma.trade.aggregate({ _sum: { amountSol: true }, where: { status: 'CONFIRMED' } }),
      prisma.performanceFeeLedger.aggregate({ _sum: { feeUsd: true } }),
      prisma.referralReward.aggregate({ _sum: { rewardUsd: true } }),
      prisma.snipeConfig.count({ where: { isActive: true, autoBuyOnLaunch: true } }),
      prisma.token.count({ where: { createdAt: { gte: since10m } } }),
      prisma.token.count({ where: { createdAt: { gte: since24h } } }),
    ]);

    const scanner = fastify.scannerHealthCoordinator?.snapshot();

    return {
      settings: {
        treasuryWalletAddress: settings.treasuryWalletAddress,
        envTreasuryWalletAddress: fastify.config.PLATFORM_TREASURY_WALLET_ADDRESS,
        performanceFeeBps: settings.performanceFeeBps,
        referralProgramEnabled: settings.referralProgramEnabled,
        referralLevels: settings.referralLevels
          .map((l) => ({ level: l.level, percentBps: l.percentBps, enabled: l.enabled }))
          .sort((a, b) => a.level - b.level),
      },
      trading: {
        mode: fastify.tradingMode ?? null,
        killSwitch,
        autoBuyPaused,
        autoBuyPausedReason: autoBuyPausedReason ?? null,
        activeSnipeConfigs,
      },
      stats: {
        users,
        newUsers24h,
        openPositions,
        trades24h,
        totalTrades,
        volumeSol24h: volume24h._sum.amountSol ?? 0,
        volumeSolTotal: volumeTotal._sum.amountSol ?? 0,
        feeRevenueUsd: feeRevenue._sum.feeUsd ?? 0,
        referralPaidUsd: referralPaid._sum.rewardUsd ?? 0,
      },
      health: {
        scannerState: scanner?.state ?? null,
        activeProvider: scanner?.activeProviderLabel ?? null,
        tokens10m,
        tokens24h,
      },
    };
  });

  fastify.put('/admin/settings/treasury', guard, async (req, reply) => {
    const { address } = treasuryBody.parse(req.body);
    return sendResult(
      reply,
      await setTreasuryWallet(fastify.prisma, actorOf(req.user.userId), address),
    );
  });

  fastify.put('/admin/settings/fee', guard, async (req, reply) => {
    const { percent } = percentBody.parse(req.body);
    const bps = Math.round(percent * 100);
    return sendResult(reply, await setPlatformFee(fastify.prisma, actorOf(req.user.userId), bps));
  });

  fastify.put('/admin/settings/referral/:level', guard, async (req, reply) => {
    const { level } = levelParams.parse(req.params);
    const { percent } = percentBody.parse(req.body);
    const bps = Math.round(percent * 100);
    return sendResult(
      reply,
      await setReferralLevel(fastify.prisma, actorOf(req.user.userId), level, bps),
    );
  });

  fastify.put('/admin/settings/referral-program', guard, async (req, reply) => {
    const { enabled } = flagBody.parse(req.body);
    await setReferralProgramEnabled(fastify.prisma, actorOf(req.user.userId), enabled);
    return reply.send({ ok: true });
  });

  fastify.put('/admin/trading/kill-switch', guard, async (req, reply) => {
    const { enabled } = flagBody.parse(req.body);
    await setKillSwitchState(fastify.redis, enabled);
    await fastify.prisma.auditLog.create({
      data: { userId: req.user.userId, action: 'admin.kill_switch', metadata: { active: enabled } },
    });
    fastify.log.warn({ userId: req.user.userId, active: enabled }, 'admin set the kill switch');
    return reply.send({ ok: true });
  });

  fastify.put('/admin/trading/auto-buy', guard, async (req, reply) => {
    const { enabled } = flagBody.parse(req.body);
    await setScannerAutoBuyPauseState(fastify.redis, !enabled, 'manually paused by admin');
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        action: 'admin.auto_buy',
        metadata: { enabled },
      },
    });
    fastify.log.warn({ userId: req.user.userId, enabled }, 'admin changed auto-buy');
    return reply.send({ ok: true });
  });

  const performanceQuery = z.object({
    mode: z.enum(['paper', 'live']).default('paper'),
    days: z.coerce.number().int().min(1).max(365).default(30),
  });

  fastify.get('/admin/performance', guard, async (req) => {
    const { mode, days } = performanceQuery.parse(req.query);
    const since = new Date(Date.now() - days * DAY_MS);
    const positions = await fastify.prisma.position.findMany({
      where: { status: 'CLOSED', isPaperTrade: mode === 'paper', closedAt: { gte: since } },
      include: { token: { select: { dex: true } } },
      orderBy: { closedAt: 'desc' },
      take: 1000,
    });
    if (positions.length === 0)
      return { mode, days, excludedInvalid: 0, ...computePerformance([]) };

    const sells = await fastify.prisma.trade.findMany({
      where: {
        side: 'SELL',
        status: 'CONFIRMED',
        walletId: { in: [...new Set(positions.map((p) => p.walletId))] },
        tokenId: { in: [...new Set(positions.map((p) => p.tokenId))] },
        createdAt: { gte: new Date(Math.min(...positions.map((p) => p.createdAt.getTime()))) },
      },
      select: { walletId: true, tokenId: true, amountSol: true, createdAt: true },
    });

    let excludedInvalid = 0;
    const rows: ClosedPositionResult[] = [];
    for (const p of positions) {
      const closedAt = p.closedAt ?? p.createdAt;
      const holdMs = closedAt.getTime() - p.createdAt.getTime();
      if (p.isPaperTrade && holdMs < INVALID_PAPER_HOLD_MS && p.exitReason === 'stop_loss') {
        excludedInvalid++;
        continue;
      }
      // A position's sells land between its open and a little after its close.
      const windowEnd = closedAt.getTime() + 2 * 60_000;
      const returnedSol = sells
        .filter(
          (t) =>
            t.walletId === p.walletId &&
            t.tokenId === p.tokenId &&
            t.createdAt.getTime() >= p.createdAt.getTime() &&
            t.createdAt.getTime() <= windowEnd,
        )
        .reduce((sum, t) => sum + t.amountSol, 0);
      rows.push({
        investedSol: p.amountSolInvested,
        returnedSol,
        exitReason: p.exitReason,
        dex: p.token.dex,
        holdMs,
      });
    }
    return { mode, days, excludedInvalid, ...computePerformance(rows) };
  });
}
