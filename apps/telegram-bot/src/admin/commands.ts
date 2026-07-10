import type { Bot, Context, NextFunction } from 'grammy';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { getKillSwitchState, setKillSwitchState, type Logger } from '@nova/shared';

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
}
