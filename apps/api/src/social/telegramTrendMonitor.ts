import type { Logger } from '@nova/shared';
import { metrics } from '../lib/metrics.js';
import { TelegramTrendClient } from './telegramTrend.js';

export interface TelegramSignalCandidate {
  mint: string;
  channel: string;
  messageId: number;
  messageUrl: string;
}

export type TelegramSignalHandler = (candidate: TelegramSignalCandidate) => void | Promise<void>;

/**
 * Polls multiple public Telegram channels on an interval, tracking a
 * per-channel last-seen message id (same `since_id` cursor idea as
 * TwitterMonitor) so each poll only looks at genuinely new messages. Emits
 * one candidate per unique mint found, in message order. A failure on one
 * channel is logged and skipped, not fatal to the others or the next tick —
 * same resilience convention as TwitterMonitor.pollOnce.
 */
export class TelegramTrendMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly lastMessageId = new Map<string, number>();
  private polling = false;

  constructor(
    private readonly client: TelegramTrendClient,
    private readonly channels: string[],
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  async pollOnce(onCandidate: TelegramSignalHandler): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const channel of this.channels) {
        try {
          const messages = await this.client.fetchMessages(
            channel,
            this.lastMessageId.get(channel),
          );
          for (const message of messages) {
            if (message.messageId > (this.lastMessageId.get(channel) ?? 0)) {
              this.lastMessageId.set(channel, message.messageId);
            }
            // "Signal received" = one Telegram message seen, regardless of whether it
            // contained a mint; "mints extracted" = the candidates actually pulled out
            // of it — kept as two separate counters since most messages have zero.
            metrics.increment('telegramSignalsReceived');
            metrics.increment('mintsExtracted', message.mints.length);
            for (const mint of message.mints) {
              await onCandidate({
                mint,
                channel: message.channel,
                messageId: message.messageId,
                messageUrl: message.messageUrl,
              });
            }
          }
        } catch (err) {
          this.logger.warn(
            { err, channel },
            'telegram trend channel poll failed, will retry next interval',
          );
        }
      }
    } finally {
      this.polling = false;
    }
  }

  start(onCandidate: TelegramSignalHandler): void {
    if (this.timer) return;
    void this.pollOnce(onCandidate);
    this.timer = setInterval(() => void this.pollOnce(onCandidate), this.intervalMs);
    this.logger.info(
      { channels: this.channels, intervalMs: this.intervalMs },
      'telegram trend monitor started',
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
