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
  const userFindMany = vi.fn().mockResolvedValue([]);

  return {
    deps: {
      prisma: {
        position: { findMany: positionFindMany, update: vi.fn() },
        trade: {
          findFirst: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
        },
        tradeShowcaseDailySummary: { findUnique: summaryFindUnique, create: summaryCreate },
        user: { findMany: userFindMany },
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
    userFindMany,
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

describe('TradeShowcaseMonitor — real bot trade DM broadcast', () => {
  function fakeEligiblePosition() {
    return {
      id: 'pos1',
      walletId: 'wallet1',
      tokenId: 'token1',
      status: 'CLOSED',
      isPaperTrade: false,
      showcasePostedAt: null,
      closedAt: new Date('2026-07-27T10:30:00Z'),
      createdAt: new Date('2026-07-27T10:00:00Z'),
      amountSolInvested: 1,
      entryPriceUsd: 0.001,
      realizedPnlUsd: 25,
      riskScoreAtEntry: 92,
      token: {
        mint: 'MintAbc123',
        name: 'Example Token',
        symbol: 'EXT',
        dex: 'RAYDIUM',
        isHoneypotSuspected: false,
      },
    };
  }

  it('DMs every subscribed telegramId the identical message, in addition to the channel post', async () => {
    const { deps, sendMessage, userFindMany } = fakeDeps();
    (deps as never as { prisma: Record<string, unknown> }).prisma = {
      ...(deps as never as { prisma: Record<string, unknown> }).prisma,
      position: {
        findMany: vi.fn().mockResolvedValue([fakeEligiblePosition()]),
        update: vi.fn().mockResolvedValue(undefined),
      },
      trade: {
        findFirst: vi
          .fn()
          .mockResolvedValue({
            createdAt: new Date('2026-07-27T10:00:00Z'),
            txSignature: 'buySig',
          }),
        findMany: vi.fn().mockResolvedValue([
          {
            createdAt: new Date('2026-07-27T10:30:00Z'),
            amountSol: 1.25,
            priceUsd: 0.00125,
            txSignature: 'sellSig',
          },
        ]),
      },
    };
    userFindMany.mockResolvedValue([{ telegramId: 'chat1' }, { telegramId: 'chat2' }]);

    const monitor = new TradeShowcaseMonitor(deps);
    await monitor.tick();

    const channelCalls = sendMessage.mock.calls.filter(
      (call) => call[0] === '@testchannel' && (call[1] as string).includes('REAL BOT TRADE'),
    );
    const dmCalls = sendMessage.mock.calls.filter((call) =>
      ['chat1', 'chat2'].includes(call[0] as string),
    );
    expect(channelCalls).toHaveLength(1);
    expect(dmCalls).toHaveLength(2);
    // Identical message text to every recipient, channel included.
    expect(dmCalls[0]![1]).toBe(channelCalls[0]![1]);
    expect(dmCalls[1]![1]).toBe(channelCalls[0]![1]);
  });

  it('still posts to the channel and marks the trade showcased even if a DM send fails', async () => {
    const { deps, sendMessage, userFindMany } = fakeDeps();
    const positionUpdate = vi.fn().mockResolvedValue(undefined);
    (deps as never as { prisma: Record<string, unknown> }).prisma = {
      ...(deps as never as { prisma: Record<string, unknown> }).prisma,
      position: {
        findMany: vi.fn().mockResolvedValue([fakeEligiblePosition()]),
        update: positionUpdate,
      },
      trade: {
        findFirst: vi
          .fn()
          .mockResolvedValue({
            createdAt: new Date('2026-07-27T10:00:00Z'),
            txSignature: 'buySig',
          }),
        findMany: vi.fn().mockResolvedValue([
          {
            createdAt: new Date('2026-07-27T10:30:00Z'),
            amountSol: 1.25,
            priceUsd: 0.00125,
            txSignature: 'sellSig',
          },
        ]),
      },
    };
    userFindMany.mockResolvedValue([{ telegramId: 'brokenChat' }]);
    sendMessage.mockImplementation((chatId: string) => {
      if (chatId === 'brokenChat') return Promise.reject(new Error('blocked'));
      return Promise.resolve({ message_id: 1 });
    });

    const monitor = new TradeShowcaseMonitor(deps);
    await monitor.tick();

    expect(positionUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pos1' } }));
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
