import { describe, expect, it, vi } from 'vitest';
import { TwitterMonitor } from './twitterMonitor.js';
import type { TwitterClient } from './twitter.js';

function fakeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

describe('TwitterMonitor', () => {
  it('passes the returned newestId as since_id on the next poll', async () => {
    const searchRecent = vi
      .fn()
      .mockResolvedValueOnce({ tweets: [{ id: '100', text: 'first' }], newestId: '100' })
      .mockResolvedValueOnce({ tweets: [{ id: '101', text: 'second' }], newestId: '101' });

    const client = { searchRecent } as unknown as TwitterClient;
    const monitor = new TwitterMonitor(client, 'query', 60000, fakeLogger());
    const onTweet = vi.fn();

    await monitor.pollOnce(onTweet);
    await monitor.pollOnce(onTweet);

    expect(searchRecent).toHaveBeenNthCalledWith(1, 'query', undefined);
    expect(searchRecent).toHaveBeenNthCalledWith(2, 'query', '100');
    expect(onTweet).toHaveBeenCalledTimes(2);
  });

  it('logs and swallows errors instead of throwing', async () => {
    const searchRecent = vi.fn().mockRejectedValue(new Error('rate limited'));
    const client = { searchRecent } as unknown as TwitterClient;
    const logger = fakeLogger();
    const monitor = new TwitterMonitor(client, 'query', 60000, logger);

    await expect(monitor.pollOnce(vi.fn())).resolves.toBeUndefined();
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  it('ignores overlapping poll calls while one is in flight', async () => {
    let resolveFirst: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const searchRecent = vi.fn().mockImplementation(async () => {
      await inFlight;
      return { tweets: [], newestId: undefined };
    });
    const client = { searchRecent } as unknown as TwitterClient;
    const monitor = new TwitterMonitor(client, 'query', 60000, fakeLogger());

    const first = monitor.pollOnce(vi.fn());
    const second = monitor.pollOnce(vi.fn());
    resolveFirst!();
    await Promise.all([first, second]);

    expect(searchRecent).toHaveBeenCalledTimes(1);
  });
});
