import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { Bot } from '@nova/telegram-bot';
import { sendBrandedPhotoHtml } from '../telegramSend.js';
import type { ButtonSpec } from '../tokenButtons.js';
import { classifyTelegramError } from '../tradeShowcase/telegramErrorClassifier.js';

/**
 * Durable Telegram broadcast queue for the Network Trade Feed — worker side
 * (2026-08-03). Drains NetworkTradeBroadcast rows (created by
 * broadcastQueue.ts's enqueueNetworkTradeBroadcast) on its own tick, same
 * fully-decoupled/crash-safe shape as tradeShowcase's BroadcastWorker (own
 * copy, not a cross-import — see this module's own doc comment on
 * broadcastQueue.ts). Simpler than that one: photoFileId/buttonsJson are
 * always already known at creation time (captured from the channel post
 * itself), so there's no per-broadcast "resolve the photo" step — every
 * delivery just reuses sendBrandedPhotoHtml with the exact same fileId/
 * caption/buttons the channel got.
 */

export interface NetworkTradeBroadcastWorkerDeps {
  prisma: PrismaClient;
  bot: Bot;
  logger: Logger;
}

/** Same rate-limit-safety margins as tradeShowcase's BroadcastWorker. */
const BATCH_SIZE = 25;
const BATCH_SPACING_MS = 1_000;
const MAX_TRANSIENT_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

function computeBroadcastRetryBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseButtonRows(buttonsJson: string): ButtonSpec[][] {
  try {
    const parsed = JSON.parse(buttonsJson);
    return Array.isArray(parsed) ? (parsed as ButtonSpec[][]) : [];
  } catch {
    return [];
  }
}

export class NetworkTradeBroadcastWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly deps: NetworkTradeBroadcastWorkerDeps) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const broadcast = await this.deps.prisma.networkTradeBroadcast.findFirst({
        where: { status: { in: ['PENDING', 'IN_PROGRESS'] } },
        orderBy: { createdAt: 'asc' },
      });
      if (broadcast) await this.processBroadcast(broadcast);
    } catch (err) {
      this.deps.logger.error({ err }, 'network trade broadcast worker: tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private async processBroadcast(broadcast: {
    id: string;
    entryId: string;
    caption: string;
    photoFileId: string;
    buttonsJson: string;
    status: string;
  }): Promise<void> {
    if (broadcast.status === 'PENDING') {
      await this.deps.prisma.networkTradeBroadcast.update({
        where: { id: broadcast.id },
        data: { status: 'IN_PROGRESS' },
      });
    }

    const buttonRows = parseButtonRows(broadcast.buttonsJson);

    for (;;) {
      const now = new Date();
      const candidates = await this.deps.prisma.networkTradeBroadcastDelivery.findMany({
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
      if (eligible.length === 0) break;

      for (const delivery of eligible) {
        try {
          await sendBrandedPhotoHtml(
            this.deps.bot,
            delivery.telegramChatId,
            { fileId: broadcast.photoFileId },
            broadcast.caption,
            buttonRows,
          );
          await this.deps.prisma.networkTradeBroadcastDelivery.update({
            where: { id: delivery.id },
            data: { status: 'SENT', sentAt: new Date(), lastAttemptAt: new Date() },
          });
          await this.deps.prisma.networkTradeBroadcast.update({
            where: { id: broadcast.id },
            data: { sentCount: { increment: 1 } },
          });
          this.deps.logger.debug(
            { broadcastId: broadcast.id, userId: delivery.userId },
            'network trade broadcast worker: delivery sent',
          );
        } catch (err) {
          const classification = classifyTelegramError(err);
          if (classification.kind === 'permanent') {
            await this.deps.prisma.networkTradeBroadcastDelivery.update({
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
            await this.deps.prisma.networkTradeBroadcast.update({
              where: { id: broadcast.id },
              data: { failedPermanentCount: { increment: 1 } },
            });
            this.deps.logger.warn(
              {
                broadcastId: broadcast.id,
                userId: delivery.userId,
                reason: classification.reason,
              },
              'network trade broadcast worker: delivery permanently failed — user marked inactive, will never be retried',
            );
          } else {
            const attempts = delivery.attempts + 1;
            const terminal = attempts >= MAX_TRANSIENT_ATTEMPTS;
            await this.deps.prisma.networkTradeBroadcastDelivery.update({
              where: { id: delivery.id },
              data: {
                status: terminal ? 'FAILED_TEMP' : 'PENDING',
                attempts,
                lastError: classification.reason,
                lastAttemptAt: new Date(),
              },
            });
            if (terminal) {
              await this.deps.prisma.networkTradeBroadcast.update({
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
                'network trade broadcast worker: delivery exhausted transient retries — giving up, logged as failed',
              );
            } else {
              this.deps.logger.warn(
                {
                  broadcastId: broadcast.id,
                  userId: delivery.userId,
                  attempts,
                  reason: classification.reason,
                },
                'network trade broadcast worker: delivery failed transiently — will retry with backoff',
              );
            }
          }
        }
      }

      await sleep(BATCH_SPACING_MS);
    }

    const remaining = await this.deps.prisma.networkTradeBroadcastDelivery.count({
      where: { broadcastId: broadcast.id, status: 'PENDING' },
    });
    if (remaining > 0) return;

    const failed = await this.deps.prisma.networkTradeBroadcastDelivery.count({
      where: { broadcastId: broadcast.id, status: { in: ['FAILED_PERMANENT', 'FAILED_TEMP'] } },
    });
    await this.deps.prisma.networkTradeBroadcast.update({
      where: { id: broadcast.id },
      data: {
        status: failed > 0 ? 'COMPLETED_WITH_FAILURES' : 'COMPLETED',
        completedAt: new Date(),
      },
    });
    this.deps.logger.info(
      { broadcastId: broadcast.id, entryId: broadcast.entryId, failed },
      'network trade broadcast worker: broadcast fully drained',
    );
  }
}
