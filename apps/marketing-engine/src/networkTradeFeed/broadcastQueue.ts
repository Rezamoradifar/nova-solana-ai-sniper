import type { PrismaClient } from '@prisma/client';

/**
 * Durable Telegram broadcast queue for the Network Trade Feed — enqueue side
 * (2026-08-03). Same DB-only-writes/fast-return shape as tradeShowcase's
 * broadcastQueue.ts (own copy, not a cross-import — see this package's other
 * sibling feed folders for why), but keyed by entryId instead of positionId,
 * and always created with a real photoFileId/buttonsJson already known —
 * the caller enqueues only AFTER the channel post itself has already
 * succeeded, reusing that exact send result so the DM broadcast is
 * byte-identical to what the channel got, never a re-render.
 */

const CHUNK_SIZE = 5_000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export interface EnqueueNetworkTradeBroadcastResult {
  broadcastId: string;
  recipientCount: number;
}

/**
 * Idempotent per entryId (NetworkTradeBroadcast.entryId is unique) — a
 * caller that somehow enqueues the same trade twice gets a unique-constraint
 * error on the second attempt rather than a duplicate broadcast; callers
 * should treat that as "already enqueued," not a failure (matches
 * enqueueTradeBroadcast's own per-trade dedup convention).
 */
export async function enqueueNetworkTradeBroadcast(
  prisma: PrismaClient,
  entryId: string,
  caption: string,
  photoFileId: string,
  buttonsJson: string,
): Promise<EnqueueNetworkTradeBroadcastResult> {
  const recipients = await prisma.user.findMany({
    where: { telegramId: { not: null }, telegramActive: true },
    select: { id: true, telegramId: true },
  });

  const broadcast = await prisma.networkTradeBroadcast.create({
    data: { entryId, caption, photoFileId, buttonsJson, totalRecipients: recipients.length },
  });

  for (const batch of chunk(recipients, CHUNK_SIZE)) {
    await prisma.networkTradeBroadcastDelivery.createMany({
      data: batch.map((user) => ({
        broadcastId: broadcast.id,
        userId: user.id,
        telegramChatId: user.telegramId!,
      })),
    });
  }

  return { broadcastId: broadcast.id, recipientCount: recipients.length };
}
