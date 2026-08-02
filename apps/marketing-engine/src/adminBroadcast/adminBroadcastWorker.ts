import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { Bot } from 'grammy';
import { classifyTelegramError } from '../tradeShowcase/telegramErrorClassifier.js';

/**
 * Durable Telegram broadcast queue for arbitrary admin-authored announcements
 * (2026-07-31) — worker/drain side. Same tick/batch/backoff/blocked-user
 * shape as tradeShowcase/broadcastWorker.ts, minus the photo-resolution
 * machinery (this queue is text-only) and sent with no parse_mode —
 * admin-authored text isn't guaranteed Markdown-safe the way the generated
 * trade captions are (they escapeMd every dynamic field going in), so plain
 * text avoids a stray "_"/"*"/"`" silently breaking the send, same rationale
 * as NotificationService.broadcastCustomMessage in @nova/telegram-bot.
 */

export interface AdminBroadcastWorkerDeps {
  prisma: PrismaClient;
  bot: Bot;
  logger: Logger;
}

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

export class AdminBroadcastWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly deps: AdminBroadcastWorkerDeps) {}

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
      const broadcast = await this.deps.prisma.adminBroadcast.findFirst({
        where: { status: { in: ['PENDING', 'IN_PROGRESS'] } },
        orderBy: { createdAt: 'asc' },
      });
      if (broadcast) await this.processBroadcast(broadcast);
    } catch (err) {
      this.deps.logger.error({ err }, 'admin broadcast worker: tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private async processBroadcast(broadcast: {
    id: string;
    text: string;
    status: string;
  }): Promise<void> {
    if (broadcast.status === 'PENDING') {
      await this.deps.prisma.adminBroadcast.update({
        where: { id: broadcast.id },
        data: { status: 'IN_PROGRESS' },
      });
    }

    for (;;) {
      const now = new Date();
      const candidates = await this.deps.prisma.adminBroadcastDelivery.findMany({
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
          await this.deps.bot.api.sendMessage(delivery.telegramChatId, broadcast.text);
          await this.deps.prisma.adminBroadcastDelivery.update({
            where: { id: delivery.id },
            data: { status: 'SENT', sentAt: new Date(), lastAttemptAt: new Date() },
          });
          await this.deps.prisma.adminBroadcast.update({
            where: { id: broadcast.id },
            data: { sentCount: { increment: 1 } },
          });
          this.deps.logger.debug(
            { broadcastId: broadcast.id, userId: delivery.userId },
            'admin broadcast worker: delivery sent',
          );
        } catch (err) {
          const classification = classifyTelegramError(err);
          if (classification.kind === 'permanent') {
            await this.deps.prisma.adminBroadcastDelivery.update({
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
            await this.deps.prisma.adminBroadcast.update({
              where: { id: broadcast.id },
              data: { failedPermanentCount: { increment: 1 } },
            });
            this.deps.logger.warn(
              {
                broadcastId: broadcast.id,
                userId: delivery.userId,
                reason: classification.reason,
              },
              'admin broadcast worker: delivery permanently failed — user marked inactive, will never be retried',
            );
          } else {
            const attempts = delivery.attempts + 1;
            const terminal = attempts >= MAX_TRANSIENT_ATTEMPTS;
            await this.deps.prisma.adminBroadcastDelivery.update({
              where: { id: delivery.id },
              data: {
                status: terminal ? 'FAILED_TEMP' : 'PENDING',
                attempts,
                lastError: classification.reason,
                lastAttemptAt: new Date(),
              },
            });
            if (terminal) {
              await this.deps.prisma.adminBroadcast.update({
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
                'admin broadcast worker: delivery exhausted transient retries — giving up, logged as failed',
              );
            } else {
              this.deps.logger.warn(
                {
                  broadcastId: broadcast.id,
                  userId: delivery.userId,
                  attempts,
                  reason: classification.reason,
                },
                'admin broadcast worker: delivery failed transiently — will retry with backoff',
              );
            }
          }
        }
      }

      await sleep(BATCH_SPACING_MS);
    }

    const remaining = await this.deps.prisma.adminBroadcastDelivery.count({
      where: { broadcastId: broadcast.id, status: 'PENDING' },
    });
    if (remaining > 0) return;

    const failed = await this.deps.prisma.adminBroadcastDelivery.count({
      where: { broadcastId: broadcast.id, status: { in: ['FAILED_PERMANENT', 'FAILED_TEMP'] } },
    });
    await this.deps.prisma.adminBroadcast.update({
      where: { id: broadcast.id },
      data: {
        status: failed > 0 ? 'COMPLETED_WITH_FAILURES' : 'COMPLETED',
        completedAt: new Date(),
      },
    });
    this.deps.logger.info(
      { broadcastId: broadcast.id, failed },
      'admin broadcast worker: broadcast fully drained',
    );
  }
}
