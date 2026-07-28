import { describe, expect, it, vi } from 'vitest';
import { TradeShowcaseMonitor } from './monitor.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
  const positionFindMany = vi.fn().mockResolvedValue([]);
  const summaryFindUnique = vi.fn().mockResolvedValue(null);
  const summaryCreate = vi.fn().mockResolvedValue(undefined);

  return {
    deps: {
      prisma: {
        position: { findMany: positionFindMany, update: vi.fn() },
        trade: {
          findFirst: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
        },
        tradeShowcaseDailySummary: { findUnique: summaryFindUnique, create: summaryCreate },
      },
      bot: { api: { sendMessage } },
      chatId: '@testchannel',
      logger: fakeLogger(),
      maxPostsPerTick: 3,
      deployedAt: new Date('2026-07-27T00:00:00Z'),
      marketData: { fetchEnrichment: vi.fn().mockResolvedValue(undefined) },
      ...overrides,
    } as never,
    sendMessage,
    positionFindMany,
    summaryFindUnique,
    summaryCreate,
  };
}

describe('TradeShowcaseMonitor — daily summary deployment cutoff', () => {
  it('never posts a daily summary for a UTC day that ended entirely before deployment', async () => {
    // "Today" is fixed via system time below; deployedAt is set to right now,
    // so "yesterday" (the day the summary would normally cover) is entirely
    // pre-deployment and must be skipped outright — no post, no summary row.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T02:30:00Z'));
    const { deps, sendMessage, summaryFindUnique, summaryCreate } = fakeDeps({
      deployedAt: new Date('2026-07-27T02:22:54Z'),
    });

    const monitor = new TradeShowcaseMonitor(deps);
    await monitor.tick();

    expect(summaryFindUnique).not.toHaveBeenCalled();
    expect(summaryCreate).not.toHaveBeenCalled();
    // sendMessage may still be called zero times for the per-trade feed
    // (no eligible trades in this fixture) — assert specifically that no
    // daily-summary-shaped message went out.
    const summaryCalls = sendMessage.mock.calls.filter((call) =>
      (call[1] as string).includes('DAILY PERFORMANCE'),
    );
    expect(summaryCalls).toHaveLength(0);
    vi.useRealTimers();
  });

  it('does post a daily summary once a full UTC day exists entirely after deployment', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T01:00:00Z'));
    const { deps, sendMessage, summaryCreate } = fakeDeps({
      // deployed two days before "today" — "yesterday" (2026-07-28) is
      // entirely after deployment, so it should be summarized normally.
      deployedAt: new Date('2026-07-27T00:00:00Z'),
    });

    const monitor = new TradeShowcaseMonitor(deps);
    await monitor.tick();

    const summaryCalls = sendMessage.mock.calls.filter((call) =>
      (call[1] as string).includes('DAILY PERFORMANCE'),
    );
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCreate).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('TradeShowcaseMonitor — per-trade feed cutoff', () => {
  it('passes deployedAt through to the eligibility query', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T02:30:00Z'));
    const cutoff = new Date('2026-07-27T02:22:54Z');
    const { deps, positionFindMany } = fakeDeps({ deployedAt: cutoff });

    const monitor = new TradeShowcaseMonitor(deps);
    await monitor.tick();

    expect(positionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ closedAt: { not: null, gte: cutoff } }),
      }),
    );
    vi.useRealTimers();
  });
});
