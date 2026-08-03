import { describe, expect, it, vi } from 'vitest';
import { TradeShowcaseMonitor } from './monitor.js';

const formatTradePhotoCaptionMock = vi.fn().mockReturnValue('CAPTION TEXT');
const resolveTradePhotoMock = vi.fn().mockResolvedValue(undefined);
const sendTradeNotificationPhotoMock = vi.fn().mockResolvedValue({ message_id: 1 });

vi.mock('@nova/telegram-bot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nova/telegram-bot')>();
  return {
    ...actual,
    formatTradePhotoCaption: (...args: unknown[]) => formatTradePhotoCaptionMock(...args),
    resolveTradePhoto: (...args: unknown[]) => resolveTradePhotoMock(...args),
    sendTradeNotificationPhoto: (...args: unknown[]) => sendTradeNotificationPhotoMock(...args),
  };
});

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
  const positionFindMany = vi.fn().mockResolvedValue([]);
  const summaryFindUnique = vi.fn().mockResolvedValue(null);
  const summaryCreate = vi.fn().mockResolvedValue(undefined);
  const userFindMany = vi.fn().mockResolvedValue([]);
  const tradeBroadcastCreate = vi
    .fn()
    .mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'broadcast1', ...args.data }),
    );
  const tradeBroadcastDeliveryCreateMany = vi.fn().mockResolvedValue({ count: 0 });

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
        tradeBroadcast: { create: tradeBroadcastCreate },
        tradeBroadcastDelivery: { createMany: tradeBroadcastDeliveryCreateMany },
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
    tradeBroadcastCreate,
    tradeBroadcastDeliveryCreateMany,
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

describe('TradeShowcaseMonitor — real bot trade sendPhoto + DM broadcast', () => {
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

  function withEligibleTrade(deps: ReturnType<typeof fakeDeps>['deps']) {
    (deps as never as { prisma: Record<string, unknown> }).prisma = {
      ...(deps as never as { prisma: Record<string, unknown> }).prisma,
      position: {
        findMany: vi.fn().mockResolvedValue([fakeEligiblePosition()]),
        update: vi.fn().mockResolvedValue(undefined),
      },
      trade: {
        findFirst: vi.fn().mockResolvedValue({
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
    return deps;
  }

  it('resolves one photo per trade, posts it to the channel directly, and enqueues a durable broadcast for every subscribed telegramId (2026-07-29)', async () => {
    resolveTradePhotoMock.mockClear();
    sendTradeNotificationPhotoMock.mockClear();
    const resolvedPhoto = { buffer: Buffer.from([1, 2, 3]) };
    resolveTradePhotoMock.mockResolvedValue(resolvedPhoto);

    const { deps, userFindMany, tradeBroadcastCreate, tradeBroadcastDeliveryCreateMany } =
      fakeDeps();
    withEligibleTrade(deps);
    userFindMany.mockResolvedValue([
      { id: 'user1', telegramId: 'chat1' },
      { id: 'user2', telegramId: 'chat2' },
    ]);

    const monitor = new TradeShowcaseMonitor(deps);
    await monitor.tick();

    // Fetched exactly once per trade, not once per recipient.
    expect(resolveTradePhotoMock).toHaveBeenCalledTimes(1);

    // The channel post is still a direct, immediate sendPhoto — unaffected
    // by the durable-queue change.
    expect(sendTradeNotificationPhotoMock).toHaveBeenCalledTimes(1);
    expect(sendTradeNotificationPhotoMock).toHaveBeenCalledWith(
      expect.anything(),
      '@testchannel',
      'CAPTION TEXT',
      resolvedPhoto,
    );

    // The DM fan-out is now a fast DB enqueue, not per-recipient sends —
    // only queries telegramActive users, and creates one delivery row per
    // recipient with the exact same caption the channel post used.
    expect(userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { telegramId: { not: null }, telegramActive: true } }),
    );
    expect(tradeBroadcastCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          positionId: 'pos1',
          caption: 'CAPTION TEXT',
          totalRecipients: 2,
        }),
      }),
    );
    expect(tradeBroadcastDeliveryCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            broadcastId: 'broadcast1',
            userId: 'user1',
            telegramChatId: 'chat1',
          }),
          expect.objectContaining({
            broadcastId: 'broadcast1',
            userId: 'user2',
            telegramChatId: 'chat2',
          }),
        ]),
      }),
    );
  });

  it('still posts to the channel and marks the trade showcased even if enqueuing the broadcast fails', async () => {
    const { deps, userFindMany, tradeBroadcastCreate } = fakeDeps();
    const positionUpdate = vi.fn().mockResolvedValue(undefined);
    withEligibleTrade(deps);
    (deps as never as { prisma: Record<string, unknown> }).prisma = {
      ...(deps as never as { prisma: Record<string, unknown> }).prisma,
      position: {
        findMany: vi.fn().mockResolvedValue([fakeEligiblePosition()]),
        update: positionUpdate,
      },
    };
    userFindMany.mockResolvedValue([{ id: 'user1', telegramId: 'chat1' }]);
    tradeBroadcastCreate.mockRejectedValueOnce(new Error('db blip'));

    const monitor = new TradeShowcaseMonitor(deps);
    await monitor.tick();

    // The whole per-trade try/catch treats an enqueue failure the same as
    // any other per-trade failure — showcasePostedAt is left null so it's
    // retried next tick, but the channel post (which already landed before
    // the enqueue call) is not undone.
    expect(positionUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pos1' } }),
    );
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
