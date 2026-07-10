import type { Logger } from '@nova/shared';
import type { Tweet, TwitterClient } from './twitter.js';

export type TweetHandler = (tweet: Tweet) => void | Promise<void>;

/**
 * Polls the X API v2 recent-search endpoint on an interval, using `since_id`
 * for native de-duplication (each poll only returns tweets newer than the
 * last one seen) rather than tracking a growing set of seen IDs in memory.
 * Rate-limit errors are logged and skipped rather than crashing the loop —
 * the next tick just tries again.
 */
export class TwitterMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private sinceId: string | undefined;
  private polling = false;

  constructor(
    private readonly client: TwitterClient,
    private readonly query: string,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  /** One poll cycle, extracted so it can be driven directly in tests without fake timers. */
  async pollOnce(onTweet: TweetHandler): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const { tweets, newestId } = await this.client.searchRecent(this.query, this.sinceId);
      if (newestId) this.sinceId = newestId;
      for (const tweet of tweets) {
        await onTweet(tweet);
      }
    } catch (err) {
      this.logger.warn({ err }, 'twitter poll failed, will retry next interval');
    } finally {
      this.polling = false;
    }
  }

  start(onTweet: TweetHandler): void {
    if (this.timer) return;
    void this.pollOnce(onTweet);
    this.timer = setInterval(() => void this.pollOnce(onTweet), this.intervalMs);
    this.logger.info({ query: this.query, intervalMs: this.intervalMs }, 'twitter monitor started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
