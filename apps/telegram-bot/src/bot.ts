import { Bot } from 'grammy';
import type { Logger } from '@nova/shared';

export function createBot(token: string, logger: Logger): Bot {
  const bot = new Bot(token);
  bot.catch((err) => {
    // grammy's global error boundary: a handler throwing must never crash the process.
    logger.error({ err: err.error, ctx: err.ctx.update }, 'unhandled telegram bot error');
  });
  return bot;
}
