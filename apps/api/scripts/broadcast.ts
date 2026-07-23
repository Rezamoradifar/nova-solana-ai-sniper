/**
 * One-off admin broadcast to the same recipient set as the sniper alerts
 * (owner + every active-SnipeConfig user) — see
 * NotificationService.broadcastCustomMessage in @nova/telegram-bot.
 *
 * Usage:
 *   npm run broadcast --workspace apps/api -- "message text"
 */
import { PrismaClient } from '@prisma/client';
import { createLogger } from '@nova/shared';
import { createBot, NotificationService } from '@nova/telegram-bot';
import { loadApiEnv } from '../src/config/env.js';

async function main() {
  const text = process.argv[2];
  if (!text) {
    console.error('Usage: broadcast.ts "message text"');
    process.exit(1);
  }

  const env = loadApiEnv();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — cannot broadcast.');
    process.exit(1);
  }

  const logger = createLogger('broadcast-script');
  const prisma = new PrismaClient();
  const bot = createBot(env.TELEGRAM_BOT_TOKEN, logger as never);
  const notifier = new NotificationService(bot, env.TELEGRAM_CHAT_ID, prisma, logger as never);

  const { sent, failed } = await notifier.broadcastCustomMessage(text);
  console.log(`Broadcast complete: ${sent} sent, ${failed} failed.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
