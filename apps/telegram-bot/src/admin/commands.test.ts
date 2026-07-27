import { describe, expect, it, vi } from 'vitest';
import type { Bot, Context, NextFunction } from 'grammy';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Logger } from '@nova/shared';
import { registerAdminCommands } from './commands.js';

type Handler = (ctx: Context, next: NextFunction) => Promise<void>;

/** Captures every bot.command(name, ...handlers) registration so a single
 * command's full middleware chain (admin gate + handler) can be invoked
 * directly, without a real grammy Bot/Telegram connection. */
function fakeBot() {
  const commands = new Map<string, Handler[]>();
  const bot = {
    command: (name: string, ...handlers: Handler[]) => {
      commands.set(name, handlers);
    },
  } as unknown as Bot;
  return {
    bot,
    async run(name: string, ctx: Context): Promise<void> {
      const handlers = commands.get(name);
      if (!handlers) throw new Error(`no handler registered for /${name}`);
      let i = 0;
      const next: NextFunction = async () => {
        const handler = handlers[i++];
        if (handler) await handler(ctx, next);
      };
      await next();
    },
  };
}

function fakeCtx(reply: ReturnType<typeof vi.fn>): Context {
  return { from: { id: 999 }, reply, match: '' } as unknown as Context;
}

const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const fakeRedis = {} as unknown as Redis;

describe('/stats admin command', () => {
  it('rejects a non-admin sender without touching prisma', async () => {
    const { bot, run } = fakeBot();
    const prisma = { user: { count: vi.fn() } } as unknown as PrismaClient;
    registerAdminCommands(bot, prisma, new Set(['admin-id']), fakeLogger, fakeRedis);

    const reply = vi.fn();
    await run('stats', fakeCtx(reply));

    expect(reply).toHaveBeenCalledWith(expect.stringContaining('not authorized'));
    expect(prisma.user.count as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('reports member counts, growth rate, active users, trades, volume, and uptime', async () => {
    const { bot, run } = fakeBot();
    const userCount = vi
      .fn()
      .mockResolvedValueOnce(2541) // totalMembers
      .mockResolvedValueOnce(3) // newToday
      .mockResolvedValueOnce(20) // newThisWeek
      .mockResolvedValueOnce(80); // newThisMonth
    const prisma = {
      user: { count: userCount },
      trade: {
        count: vi.fn().mockResolvedValue(1234),
        aggregate: vi.fn().mockResolvedValue({ _sum: { amountSol: 567.891 } }),
        groupBy: vi.fn().mockResolvedValue([{ walletId: 'w1' }, { walletId: 'w2' }]),
      },
      wallet: {
        findMany: vi.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]),
      },
    } as unknown as PrismaClient;
    registerAdminCommands(bot, prisma, new Set(['999']), fakeLogger, fakeRedis);

    const reply = vi.fn();
    await run('stats', fakeCtx(reply));

    expect(reply).toHaveBeenCalledTimes(1);
    const text = reply.mock.calls[0]![0] as string;
    expect(text).toContain('Total Members: 2,541');
    expect(text).toContain('New Today: 3');
    expect(text).toContain('New This Week: 20');
    expect(text).toContain('New This Month: 80');
    expect(text).toContain('Growth Rate (7d):');
    expect(text).toContain('Active Users (24h): 2');
    expect(text).toContain('Total Trades: 1,234');
    expect(text).toContain('Total Volume: 567.89 SOL');
    expect(text).toContain('Server Uptime:');

    // Every membership count is scoped to registered bot users (telegramId set).
    for (const call of userCount.mock.calls) {
      expect(call[0].where.telegramId).toEqual({ not: null });
    }
    expect(prisma.trade.count as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({
      where: { status: 'CONFIRMED' },
    });
  });

  it('reports zero active users without an extra wallet lookup when nobody traded in 24h', async () => {
    const { bot, run } = fakeBot();
    const prisma = {
      user: { count: vi.fn().mockResolvedValue(0) },
      trade: {
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({ _sum: { amountSol: null } }),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      wallet: { findMany: vi.fn() },
    } as unknown as PrismaClient;
    registerAdminCommands(bot, prisma, new Set(['999']), fakeLogger, fakeRedis);

    const reply = vi.fn();
    await run('stats', fakeCtx(reply));

    expect(prisma.wallet.findMany as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    const text = reply.mock.calls[0]![0] as string;
    expect(text).toContain('Active Users (24h): 0');
    expect(text).toContain('Total Volume: 0 SOL');
  });
});
