import type { Bot, Context, NextFunction } from 'grammy';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import {
  getKillSwitchState,
  getOrCreateBusinessSettings,
  setKillSwitchState,
  type Logger,
} from '@nova/shared';

/** Restricts every command registered after this middleware to known admin Telegram IDs. */
function requireAdmin(adminIds: Set<string>) {
  return async (ctx: Context, next: NextFunction) => {
    const senderId = ctx.from?.id?.toString();
    if (!senderId || !adminIds.has(senderId)) {
      await ctx.reply('⛔ You are not authorized to use this command.');
      return;
    }
    await next();
  };
}

export function registerAdminCommands(
  bot: Bot,
  prisma: PrismaClient,
  adminIds: Set<string>,
  logger: Logger,
  redis: Redis,
): void {
  const admin = requireAdmin(adminIds);

  bot.command('status', admin, async (ctx) => {
    const [tokenCount, openPositions, users] = await Promise.all([
      prisma.token.count(),
      prisma.position.count({ where: { status: 'OPEN' } }),
      prisma.user.count(),
    ]);
    await ctx.reply(
      `📊 *System status*\nTokens tracked: ${tokenCount}\nOpen positions: ${openPositions}\nUsers: ${users}`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('stats', admin, async (ctx) => {
    const closedPositions = await prisma.position.findMany({ where: { status: 'CLOSED' } });
    const totalPnl = closedPositions.reduce((sum, p) => sum + (p.realizedPnlUsd ?? 0), 0);
    const wins = closedPositions.filter((p) => (p.realizedPnlUsd ?? 0) > 0).length;
    const winRate = closedPositions.length ? (wins / closedPositions.length) * 100 : 0;
    await ctx.reply(
      `📈 *Trading stats*\nClosed positions: ${closedPositions.length}\n` +
        `Win rate: ${winRate.toFixed(1)}%\nTotal realized PnL: $${totalPnl.toFixed(2)}`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('pauseall', admin, async (ctx) => {
    await prisma.snipeConfig.updateMany({ data: { isActive: false } });
    logger.warn({ adminId: ctx.from?.id }, 'admin paused all snipe configs');
    await ctx.reply('⏸️ All snipe configs paused.');
  });

  bot.command('resumeall', admin, async (ctx) => {
    await prisma.snipeConfig.updateMany({ data: { isActive: true } });
    logger.info({ adminId: ctx.from?.id }, 'admin resumed all snipe configs');
    await ctx.reply('▶️ All snipe configs resumed.');
  });

  // The real emergency stop — Redis-backed so it takes effect instantly on the running
  // API process, no redeploy/restart needed. Blocks new opens only; existing positions
  // can still be closed to de-risk.
  bot.command('killswitch', admin, async (ctx) => {
    const arg = String(ctx.match).trim().toLowerCase();

    if (arg === 'on') {
      await setKillSwitchState(redis, true);
      logger.warn({ adminId: ctx.from?.id }, 'admin ENABLED the emergency kill switch');
      await ctx.reply(
        '🚨 Kill switch ENABLED — all new trades are now blocked. Existing positions can still be closed.',
      );
      return;
    }
    if (arg === 'off') {
      await setKillSwitchState(redis, false);
      logger.warn({ adminId: ctx.from?.id }, 'admin disabled the emergency kill switch');
      await ctx.reply(
        '✅ Kill switch disabled — trading may resume (subject to LIVE_TRADING and other safety limits).',
      );
      return;
    }

    const active = await getKillSwitchState(redis);
    await ctx.reply(
      `Kill switch is currently ${active ? '🚨 ACTIVE (new trades blocked)' : '✅ inactive'}.\n\nUsage: /killswitch on | off`,
    );
  });

  // --- Business Settings (fee/referral system) ---
  // Every command below writes an AuditLog row (existing model, reused as-is)
  // so business-config changes are traceable the same way trading actions are.

  bot.command('setfee', admin, async (ctx) => {
    const percent = Number(String(ctx.match).trim());
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      await ctx.reply('Usage: /setfee <percent> (0-100, e.g. `/setfee 20` for 20%)');
      return;
    }
    const settings = await getOrCreateBusinessSettings(prisma);
    const feeBps = Math.round(percent * 100);
    await prisma.businessSettings.update({
      where: { id: settings.id },
      data: { performanceFeeBps: feeBps },
    });
    await prisma.auditLog.create({
      data: {
        action: 'admin.set_performance_fee',
        metadata: { adminId: ctx.from?.id, oldBps: settings.performanceFeeBps, newBps: feeBps },
      },
    });
    logger.warn({ adminId: ctx.from?.id, feeBps }, 'admin changed the performance fee');
    await ctx.reply(
      `💸 Performance fee set to *${percent}%*.\nUsers who already accepted the old rate will be prompted to re-accept before auto-trading again.`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('setreferral', admin, async (ctx) => {
    const [levelRaw, percentRaw] = String(ctx.match).trim().split(/\s+/);
    const level = Number(levelRaw);
    const percent = Number(percentRaw);
    if (
      !Number.isInteger(level) ||
      level < 1 ||
      !Number.isFinite(percent) ||
      percent < 0 ||
      percent > 100
    ) {
      await ctx.reply(
        'Usage: /setreferral <level> <percent> (e.g. `/setreferral 1 10` for 10% of the fee)',
      );
      return;
    }
    const settings = await getOrCreateBusinessSettings(prisma);
    const percentBps = Math.round(percent * 100);
    await prisma.referralLevelConfig.upsert({
      where: { businessSettingsId_level: { businessSettingsId: settings.id, level } },
      create: { businessSettingsId: settings.id, level, percentBps, enabled: true },
      update: { percentBps },
    });
    await prisma.auditLog.create({
      data: {
        action: 'admin.set_referral_level',
        metadata: { adminId: ctx.from?.id, level, percentBps },
      },
    });
    logger.warn(
      { adminId: ctx.from?.id, level, percentBps },
      'admin changed a referral level percentage',
    );
    await ctx.reply(`🔗 Referral level ${level} set to *${percent}%* of the platform fee.`, {
      parse_mode: 'Markdown',
    });
  });

  bot.command('setreferraldepth', admin, async (ctx) => {
    const depth = Number(String(ctx.match).trim());
    if (!Number.isInteger(depth) || depth < 0) {
      await ctx.reply('Usage: /setreferraldepth <n> (e.g. `/setreferraldepth 3`)');
      return;
    }
    const settings = await getOrCreateBusinessSettings(prisma);
    await prisma.businessSettings.update({
      where: { id: settings.id },
      data: { maxReferralDepth: depth },
    });
    await prisma.auditLog.create({
      data: { action: 'admin.set_referral_depth', metadata: { adminId: ctx.from?.id, depth } },
    });
    logger.warn({ adminId: ctx.from?.id, depth }, 'admin changed the max referral depth');
    await ctx.reply(`🔗 Maximum referral depth set to *${depth}*.`, { parse_mode: 'Markdown' });
  });

  bot.command('togglereferral', admin, async (ctx) => {
    const arg = String(ctx.match).trim().toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      await ctx.reply('Usage: /togglereferral on | off');
      return;
    }
    const enabled = arg === 'on';
    const settings = await getOrCreateBusinessSettings(prisma);
    await prisma.businessSettings.update({
      where: { id: settings.id },
      data: { referralProgramEnabled: enabled },
    });
    await prisma.auditLog.create({
      data: {
        action: 'admin.toggle_referral_program',
        metadata: { adminId: ctx.from?.id, enabled },
      },
    });
    logger.warn({ adminId: ctx.from?.id, enabled }, 'admin toggled the referral program');
    await ctx.reply(`🔗 Referral program ${enabled ? 'ENABLED' : 'DISABLED'}.`);
  });

  bot.command('businessreport', admin, async (ctx) => {
    const settings = await getOrCreateBusinessSettings(prisma);
    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const startOfWeek = new Date(
      startOfDay.getTime() - startOfDay.getUTCDay() * 24 * 60 * 60 * 1000,
    );
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [dailyAgg, weeklyAgg, monthlyAgg, feeStats, referralAgg, referralCount] =
      await Promise.all([
        prisma.performanceFeeLedger.aggregate({
          where: { createdAt: { gte: startOfDay } },
          _sum: { feeUsd: true },
        }),
        prisma.performanceFeeLedger.aggregate({
          where: { createdAt: { gte: startOfWeek } },
          _sum: { feeUsd: true },
        }),
        prisma.performanceFeeLedger.aggregate({
          where: { createdAt: { gte: startOfMonth } },
          _sum: { feeUsd: true },
        }),
        prisma.performanceFeeLedger.aggregate({
          _sum: { feeUsd: true, netProfitUsd: true },
          _count: true,
        }),
        prisma.referralReward.aggregate({ _sum: { rewardUsd: true } }),
        prisma.referralReward.count(),
      ]);

    const levelLines = settings.referralLevels
      .sort((a, b) => a.level - b.level)
      .map((l) => `  L${l.level}: ${(l.percentBps / 100).toFixed(1)}% ${l.enabled ? '✅' : '⏸'}`)
      .join('\n');

    await ctx.reply(
      `📊 *Business Report*\n\n` +
        `⚙️ *Settings*\nPerformance fee: ${(settings.performanceFeeBps / 100).toFixed(1)}%\n` +
        `Referral program: ${settings.referralProgramEnabled ? '✅ enabled' : '⏸ disabled'}\n` +
        `Max referral depth: ${settings.maxReferralDepth}\n${levelLines}\n\n` +
        `💰 *Revenue (Performance Fees)*\n` +
        `Today: $${(dailyAgg._sum.feeUsd ?? 0).toFixed(2)}\n` +
        `This week: $${(weeklyAgg._sum.feeUsd ?? 0).toFixed(2)}\n` +
        `This month: $${(monthlyAgg._sum.feeUsd ?? 0).toFixed(2)}\n\n` +
        `📈 *Performance Fee Statistics (all-time)*\n` +
        `Profitable trades charged: ${feeStats._count}\n` +
        `Total fees collected: $${(feeStats._sum.feeUsd ?? 0).toFixed(2)}\n` +
        `Total net profit generated: $${(feeStats._sum.netProfitUsd ?? 0).toFixed(2)}\n\n` +
        `🔗 *Referral Statistics (all-time)*\n` +
        `Rewards paid: ${referralCount}\n` +
        `Total referral payout: $${(referralAgg._sum.rewardUsd ?? 0).toFixed(2)}`,
      { parse_mode: 'Markdown' },
    );
  });
}
