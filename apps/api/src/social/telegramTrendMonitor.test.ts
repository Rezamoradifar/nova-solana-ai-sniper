import { describe, expect, it, vi } from 'vitest';
import { TelegramTrendMonitor } from './telegramTrendMonitor.js';
import type { TelegramTrendClient } from './telegramTrend.js';

function fakeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

function fakeClient(messages: Awaited<ReturnType<TelegramTrendClient['fetchMessages']>> = []) {
  return { fetchMessages: vi.fn().mockResolvedValue(messages) } as unknown as TelegramTrendClient;
}

describe('TelegramTrendMonitor', () => {
  it('polls every configured channel when no isEnabled callback is given (defaults to always-on)', async () => {
    const client = fakeClient();
    const monitor = new TelegramTrendMonitor(
      client,
      ['trendingssol', 'trending'],
      20000,
      fakeLogger(),
    );

    await monitor.pollOnce(vi.fn());

    expect(client.fetchMessages).toHaveBeenCalledTimes(2);
    expect(client.fetchMessages).toHaveBeenCalledWith('trendingssol', undefined);
    expect(client.fetchMessages).toHaveBeenCalledWith('trending', undefined);
  });

  it('skips polling entirely when isEnabled resolves false (admin paused it)', async () => {
    const client = fakeClient();
    const isEnabled = vi.fn().mockResolvedValue(false);
    const monitor = new TelegramTrendMonitor(
      client,
      ['trendingssol'],
      20000,
      fakeLogger(),
      isEnabled,
    );

    await monitor.pollOnce(vi.fn());

    expect(isEnabled).toHaveBeenCalledTimes(1);
    expect(client.fetchMessages).not.toHaveBeenCalled();
  });

  it('resumes polling on the next tick once isEnabled flips back to true', async () => {
    const client = fakeClient();
    let enabled = false;
    const monitor = new TelegramTrendMonitor(client, ['trendingssol'], 20000, fakeLogger(), () =>
      Promise.resolve(enabled),
    );

    await monitor.pollOnce(vi.fn());
    expect(client.fetchMessages).not.toHaveBeenCalled();

    enabled = true;
    await monitor.pollOnce(vi.fn());
    expect(client.fetchMessages).toHaveBeenCalledTimes(1);
  });

  it('logs a state-transition message only when the enabled state actually changes, not every tick', async () => {
    const client = fakeClient();
    const logger = fakeLogger() as { info: ReturnType<typeof vi.fn> };
    const monitor = new TelegramTrendMonitor(client, ['trendingssol'], 20000, logger as never, () =>
      Promise.resolve(true),
    );

    await monitor.pollOnce(vi.fn());
    await monitor.pollOnce(vi.fn());
    await monitor.pollOnce(vi.fn());

    const transitionLogs = logger.info.mock.calls.filter(
      (call) => call[1] === 'telegram trend monitor resumed polling',
    );
    expect(transitionLogs).toHaveLength(1);
  });

  it('emits one candidate per extracted mint and advances the per-channel cursor', async () => {
    const client = {
      fetchMessages: vi
        .fn()
        .mockResolvedValueOnce([
          {
            channel: 'trendingssol',
            messageId: 5,
            messageUrl: 'https://t.me/trendingssol/5',
            mints: ['MintA', 'MintB'],
          },
        ])
        .mockResolvedValueOnce([]), // second poll: client itself only returns messages newer than the cursor it was given
    } as unknown as TelegramTrendClient;
    const monitor = new TelegramTrendMonitor(client, ['trendingssol'], 20000, fakeLogger());
    const onCandidate = vi.fn();

    await monitor.pollOnce(onCandidate);
    await monitor.pollOnce(onCandidate);

    expect(onCandidate).toHaveBeenCalledTimes(2);
    expect(client.fetchMessages).toHaveBeenNthCalledWith(1, 'trendingssol', undefined);
    expect(client.fetchMessages).toHaveBeenNthCalledWith(2, 'trendingssol', 5);
  });
});
