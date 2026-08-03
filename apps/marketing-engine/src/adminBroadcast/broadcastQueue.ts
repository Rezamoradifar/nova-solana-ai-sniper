import type { PrismaClient } from '@prisma/client';

/**
 * Durable Telegram broadcast queue for arbitrary admin-authored announcements
 * (2026-07-31) — enqueue side. Same shape as tradeShowcase/broadcastQueue.ts's
 * enqueueTradeBroadcast: fast, DB-only writes (one AdminBroadcast row plus one
 * AdminBroadcastDelivery row per eligible recipient), the actual sends happen
 * on adminBroadcastWorker.ts's own tick.
 */

const CHUNK_SIZE = 5_000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export interface EnqueueAdminBroadcastResult {
  broadcastId: string;
  recipientCount: number;
}

/**
 * Recipient set matches enqueueTradeBroadcast exactly: every User with a
 * linked telegramId whose telegramActive flag hasn't been flipped false by a
 * prior permanent Telegram delivery failure (bot blocked/chat not
 * found/deactivated).
 */
export async function enqueueAdminBroadcast(
  prisma: PrismaClient,
  text: string,
): Promise<EnqueueAdminBroadcastResult> {
  const recipients = await prisma.user.findMany({
    where: { telegramId: { not: null }, telegramActive: true },
    select: { id: true, telegramId: true },
  });

  const broadcast = await prisma.adminBroadcast.create({
    data: { text, totalRecipients: recipients.length },
  });

  for (const batch of chunk(recipients, CHUNK_SIZE)) {
    await prisma.adminBroadcastDelivery.createMany({
      data: batch.map((user) => ({
        broadcastId: broadcast.id,
        userId: user.id,
        telegramChatId: user.telegramId!,
      })),
    });
  }

  return { broadcastId: broadcast.id, recipientCount: recipients.length };
}
