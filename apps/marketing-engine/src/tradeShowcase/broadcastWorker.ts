import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import {
  resolveTradePhoto,
  sendTradeNotificationPhoto,
  type Bot,
  type SendableTradePhoto,
} from '@nova/telegram-bot';
import { resolveShowcaseTradeByPositionId, type ShowcaseTrade } from './data.js';
import { toTradeNotificationData } from './monitor.js';
import { classifyTelegramError } from './telegramErrorClassifier.js';

/**
 * Durable Telegram broadcast queue — worker side (2026-07-29). Drains
 * TradeBroadcast rows (created by broadcastQueue.ts's enqueueTradeBroadcast)
 * on its own tick, fully decoupled from TradeShowcaseMonitor's tick: a crash
 * mid-broadcast loses nothing — every recipient's state is a DB row, not
 * in-memory — and picks up exactly where it left off on restart.
 *
 * Same start/stop/tick/`ticking`-guard shape as TradeShowcaseMonitor and
 * every other periodic worker in this codebase.
 */

export interface BroadcastWorkerDeps {
  prisma: PrismaClient;
  bot: Bot;
  logger: Logger;
}

/** Safety margin under Telegram's ~30 msg/sec global rate limit. */
const BATCH_SIZE = 25;
/** Spacing between batches within one broadcast — keeps sustained throughput
 * under Telegram's real limit even across many consecutive batches. */
const BATCH_SPACING_MS = 1_000;
/** A transient failure retries with doubling backoff up to this many times
 * before going terminal (FAILED_TEMP, logged, never retried again). */
const MAX_TRANSIENT_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/** Same doubling-backoff shape as apps/api/src/trading/sellRetryBackoff.ts's
 * computeSellRetryBackoffMs — a new, parallel implementation (different
 * domain: DM delivery retries, not on-chain sell retries), not a shared
 * function, since the two have no real reason to stay coupled. */
function computeBroadcastRetryBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BroadcastWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly deps: BroadcastWorkerDeps) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Processes exactly one broadcast fully (every batch it currently has
   * eligible work for) before returning — the `ticking` guard means a slow
   * broadcast (large recipient count) can never overlap with the next timer
   * fire, same convention as every other tick-based worker here. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const broadcast = await this.deps.prisma.tradeBroadcast.findFirst({
        where: { status: { in: ['PENDING', 'IN_PROGRESS'] } },
        orderBy: { createdAt: 'asc' },
      });
      if (broadcast) await this.processBroadcast(broadcast);
    } catch (err) {
      this.deps.logger.error({ err }, 'broadcast worker: tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private async resolvePhoto(
    broadcastId: string,
    positionId: string,
    existingFileId: string | null,
  ): Promise<SendableTradePhoto | undefined> {
    if (existingFileId) return { fileId: existingFileId };

    const trade: ShowcaseTrade | undefined = await resolveShowcaseTradeByPositionId(
      this.deps.prisma,
      positionId,
    );
    if (!trade) {
      this.deps.logger.warn(
        { broadcastId, positionId },
        'broadcast worker: could not re-resolve trade details for chart photo — sending text-only',
      );
      return undefined;
    }
    return resolveTradePhoto(toTradeNotificationData(trade, undefined));
  }

  private async processBroadcast(broadcast: {
    id: string;
    positionId: string;
    caption: string;
    photoFileId: string | null;
    status: string;
  }): Promise<void> {
    if (broadcast.status === 'PENDING') {
      await this.deps.prisma.tradeBroadcast.update({
        where: { id: broadcast.id },
        data: { status: 'IN_PROGRESS' },
      });
    }

    let photo = await this.resolvePhoto(broadcast.id, broadcast.positionId, broadcast.photoFileId);
    let photoFileId = broadcast.photoFileId ?? undefined;

    // Drains every batch this broadcast currently has eligible work for —
    // may take several BATCH_SPACING_MS-spaced iterations for a large
    // recipient count. Real, expected throughput ceiling: Telegram's own
    // rate limit, not a bug (100k recipients at ~25/sec is on the order of
    // an hour — there is no way to broadcast faster than Telegram allows).
    for (;;) {
      const now = new Date();
      const candidates = await this.deps.prisma.tradeBroadcastDelivery.findMany({
        where: { broadcastId: broadcast.id, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE * 4,
      });
      if (candidates.length === 0) break;

      const eligible = candidates
        .filter(
          (d) =>
            !d.lastAttemptAt ||
            now.getTime() - d.lastAttemptAt.getTime() >= computeBroadcastRetryBackoffMs(d.attempts),
        )
        .slice(0, BATCH_SIZE);
      if (eligible.length === 0) break; // remaining PENDING rows are all still in their backoff window

      for (const delivery of eligible) {
        try {
          const sent = await sendTradeNotificationPhoto(
            this.deps.bot,
            delivery.telegramChatId,
            broadcast.caption,
            photo,
          );
          if (!photoFileId && sent.photo && sent.photo.length > 0) {
            // Telegram returns photo sizes smallest-first — the last entry is
            // the largest, matching what a human viewing the chat would see.
            photoFileId = sent.photo[sent.photo.length - 1]!.file_id;
            photo = { fileId: photoFileId };
            await this.deps.prisma.tradeBroadcast.update({
              where: { id: broadcast.id },
              data: { photoFileId },
            });
          }
          await this.deps.prisma.tradeBroadcastDelivery.update({
            where: { id: delivery.id },
            data: { status: 'SENT', sentAt: new Date(), lastAttemptAt: new Date() },
          });
          await this.deps.prisma.tradeBroadcast.update({
            where: { id: broadcast.id },
            data: { sentCount: { increment: 1 } },
          });
          this.deps.logger.debug(
            { broadcastId: broadcast.id, userId: delivery.userId },
            'broadcast worker: delivery sent',
          );
        } catch (err) {
          const classification = classifyTelegramError(err);
          if (classification.kind === 'permanent') {
            await this.deps.prisma.tradeBroadcastDelivery.update({
              where: { id: delivery.id },
              data: {
                status: 'FAILED_PERMANENT',
                lastError: classification.reason,
                lastAttemptAt: new Date(),
              },
            });
            await this.deps.prisma.user.update({
              where: { id: delivery.userId },
              data: { telegramActive: false },
            });
            await this.deps.prisma.tradeBroadcast.update({
              where: { id: broadcast.id },
              data: { failedPermanentCount: { increment: 1 } },
            });
            this.deps.logger.warn(
              {
                broadcastId: broadcast.id,
                userId: delivery.userId,
                reason: classification.reason,
              },
              'broadcast worker: delivery permanently failed — user marked inactive, will never be retried',
            );
          } else {
            const attempts = delivery.attempts + 1;
            const terminal = attempts >= MAX_TRANSIENT_ATTEMPTS;
            await this.deps.prisma.tradeBroadcastDelivery.update({
              where: { id: delivery.id },
              data: {
                status: terminal ? 'FAILED_TEMP' : 'PENDING',
                attempts,
                lastError: classification.reason,
                lastAttemptAt: new Date(),
              },
            });
            if (terminal) {
              await this.deps.prisma.tradeBroadcast.update({
                where: { id: broadcast.id },
                data: { failedTempCount: { increment: 1 } },
              });
              this.deps.logger.error(
                {
                  broadcastId: broadcast.id,
                  userId: delivery.userId,
                  attempts,
                  reason: classification.reason,
                },
                'broadcast worker: delivery exhausted transient retries — giving up, logged as failed',
              );
            } else {
              this.deps.logger.warn(
                {
                  broadcastId: broadcast.id,
                  userId: delivery.userId,
                  attempts,
                  reason: classification.reason,
                },
                'broadcast worker: delivery failed transiently — will retry with backoff',
              );
            }
          }
        }
      }

      await sleep(BATCH_SPACING_MS);
    }

    const remaining = await this.deps.prisma.tradeBroadcastDelivery.count({
      where: { broadcastId: broadcast.id, status: 'PENDING' },
    });
    if (remaining > 0) return; // still has backoff-window deliveries — a later tick finishes it

    const failed = await this.deps.prisma.tradeBroadcastDelivery.count({
      where: { broadcastId: broadcast.id, status: { in: ['FAILED_PERMANENT', 'FAILED_TEMP'] } },
    });
    await this.deps.prisma.tradeBroadcast.update({
      where: { id: broadcast.id },
      data: {
        status: failed > 0 ? 'COMPLETED_WITH_FAILURES' : 'COMPLETED',
        completedAt: new Date(),
      },
    });
    this.deps.logger.info(
      { broadcastId: broadcast.id, positionId: broadcast.positionId, failed },
      'broadcast worker: broadcast fully drained',
    );
  }
}
