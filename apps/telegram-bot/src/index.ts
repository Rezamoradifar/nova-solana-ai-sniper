import { PrismaClient } from '@prisma/client';
import { createLogger } from '@nova/shared';
import { loadBotEnv, parseAdminIds } from './config/env.js';
import { createBot } from './bot.js';
import { registerAdminCommands } from './admin/commands.js';

const logger = createLogger('telegram-bot');

async function main() {
  const env = loadBotEnv();

  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.warn(
      'TELEGRAM_BOT_TOKEN not set — telegram-bot is disabled. Set it in .env to enable notifications, admin commands, and marketing posts.',
    );
    // Exit cleanly rather than crash-looping under PM2/Docker when the token is intentionally unset.
    return;
  }

  const prisma = new PrismaClient();
  const bot = createBot(env.TELEGRAM_BOT_TOKEN, logger);
  const adminIds = parseAdminIds(env.TELEGRAM_ADMIN_IDS);

  if (adminIds.size === 0) {
    logger.warn(
      'TELEGRAM_ADMIN_IDS not set — admin commands are registered but no one is authorized',
    );
  }

  registerAdminCommands(bot, prisma, adminIds, logger);

  await bot.start({
    onStart: () => logger.info('telegram bot started (long polling)'),
  });
}

main().catch((err) => {
  logger.error({ err }, 'telegram-bot crashed');
  process.exit(1);
});
