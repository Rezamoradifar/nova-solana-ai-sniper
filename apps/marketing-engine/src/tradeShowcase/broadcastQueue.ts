import type { PrismaClient } from '@prisma/client';

/**
 * Durable Telegram broadcast queue — enqueue side (2026-07-29). Replaces the
 * old bare `Promise.all` fan-out (monitor.ts's now-removed dmSubscribedUsers)
 * with fast, DB-only writes: creates one TradeBroadcast row plus one
 * TradeBroadcastDelivery row per eligible recipient, then returns
 * immediately. The actual sends happen entirely on broadcastWorker.ts's own
 * tick — this is what makes the broadcast "async, non-blocking" for the
 * caller (TradeShowcaseMonitor.postEligibleTrades's per-trade loop never
 * waits on 100k+ individual Telegram API calls).
 */

const CHUNK_SIZE = 5_000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export interface EnqueueTradeBroadcastResult {
  broadcastId: string;
  recipientCount: number;
}

/**
 * Idempotent per positionId (TradeBroadcast.positionId is unique) — a caller
 * that somehow enqueues the same trade twice gets a unique-constraint error
 * on the second attempt rather than a duplicate broadcast; callers should
 * treat that as "already enqueued," not a failure (matches
 * markTradeShowcased's own per-trade dedup convention in data.ts).
 */
export async function enqueueTradeBroadcast(
  prisma: PrismaClient,
  positionId: string,
  caption: string,
): Promise<EnqueueTradeBroadcastResult> {
  const recipients = await prisma.user.findMany({
    where: { telegramId: { not: null }, telegramActive: true },
    select: { id: true, telegramId: true },
  });

  const broadcast = await prisma.tradeBroadcast.create({
    data: { positionId, caption, totalRecipients: recipients.length },
  });

  for (const batch of chunk(recipients, CHUNK_SIZE)) {
    await prisma.tradeBroadcastDelivery.createMany({
      data: batch.map((user) => ({
        broadcastId: broadcast.id,
        userId: user.id,
        telegramChatId: user.telegramId!,
      })),
    });
  }

  return { broadcastId: broadcast.id, recipientCount: recipients.length };
}
