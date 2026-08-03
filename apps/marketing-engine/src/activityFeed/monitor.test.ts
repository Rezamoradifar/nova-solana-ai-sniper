import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityFeedMonitor } from './monitor.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    token: { findMany: vi.fn().mockResolvedValue([]) },
    smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([]) },
    shadowModeDecisionLog: { findMany: vi.fn().mockResolvedValue([]) },
    trade: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    position: { findMany: vi.fn().mockResolvedValue([]) },
    activityFeedPost: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as never;
}

function fakeMarketData(enrichment: unknown = undefined) {
  return { fetchEnrichment: vi.fn().mockResolvedValue(enrichment) } as never;
}

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
  const sendPhoto = vi.fn().mockResolvedValue({ message_id: 1 });
  return {
    prisma: fakePrisma(),
    bot: { api: { sendMessage, sendPhoto } },
    chatId: '@testchannel',
    logger: fakeLogger(),
    minIntervalMinutes: 15,
    maxIntervalMinutes: 120,
    maxPostsPerDay: 20,
    deployedAt: new Date('2020-01-01T00:00:00Z'),
    marketData: fakeMarketData(),
    trendingMinH1ChangePercent: 15,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-27T08:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ActivityFeedMonitor — no burst on first tick', () => {
  it('schedules the first random delay instead of posting immediately', async () => {
    const deps = fakeDeps();
    const monitor = new ActivityFeedMonitor(deps);
    await monitor.tick();
    expect(
      (deps as { bot: { api: { sendMessage: ReturnType<typeof vi.fn> } } }).bot.api.sendMessage,
    ).not.toHaveBeenCalled();
  });
});

describe('ActivityFeedMonitor — no real backlog', () => {
  it('posts nothing when every feed type has zero real backlog', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // deployedAt pinned to "now" (2026-07-27, a Monday) so the current UTC
    // week hasn't elapsed yet — otherwise WEEKLY_SUMMARY would legitimately
    // be due and post a truthful "no closed trades this week" report, same
    // precedent as TradeShowcaseMonitor's own daily summary on a zero-trade
    // day (a real, honest report, not fabricated content) — this test is
    // specifically about the *other* feed types having no backlog at all.
    const deps = fakeDeps({ deployedAt: new Date('2026-07-27T08:00:00Z') });
    const monitor = new ActivityFeedMonitor(deps);
    await monitor.tick(); // schedules first delay
    vi.setSystemTime(new Date('2026-07-27T08:16:00Z')); // past the 15-minute minimum delay
    await monitor.tick();
    expect(
      (deps as { bot: { api: { sendMessage: ReturnType<typeof vi.fn> } } }).bot.api.sendMessage,
    ).not.toHaveBeenCalled();
  });
});

describe('ActivityFeedMonitor — posts a real event and marks it', () => {
  it('sends exactly one message and records the dedup marker when a new opportunity is backlogged', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const create = vi.fn().mockResolvedValue(undefined);
    const prisma = fakePrisma({
      token: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'tok1',
            mint: 'MintA',
            name: 'Example',
            symbol: 'EXA',
            dex: 'RAYDIUM',
            liquidityUsd: 1000,
            marketCapUsd: 5000,
            aiScore: 90,
            firstSeenAt: new Date('2026-07-27T07:00:00Z'),
          },
        ]),
      },
      activityFeedPost: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        create,
      },
    });
    const deps = fakeDeps({ prisma });
    const monitor = new ActivityFeedMonitor(deps);

    await monitor.tick(); // schedules first delay
    vi.setSystemTime(new Date('2026-07-27T08:16:00Z'));
    await monitor.tick();

    const sendMessage = (deps as { bot: { api: { sendMessage: ReturnType<typeof vi.fn> } } }).bot
      .api.sendMessage;
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toContain('NEW OPPORTUNITY');
    expect(create).toHaveBeenCalledWith({ data: { feedType: 'NEW_OPPORTUNITY', refId: 'tok1' } });
  });

  it('sends as a photo with the logo when DexScreener enrichment resolves one', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const prisma = fakePrisma({
      token: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'tok1',
            mint: 'MintA',
            name: 'Example',
            symbol: 'EXA',
            dex: 'RAYDIUM',
            liquidityUsd: 1000,
            marketCapUsd: 5000,
            aiScore: 90,
            firstSeenAt: new Date('2026-07-27T07:00:00Z'),
          },
        ]),
      },
    });
    const deps = fakeDeps({
      prisma,
      marketData: fakeMarketData({
        logoUrl: 'https://example.com/logo.png',
        liquidityUsd: 1000,
        marketCapUsd: 5000,
        volume24hUsd: 200,
        priceChangeH1Percent: 5,
        chain: 'Solana',
        dexScreenerUrl: 'https://dexscreener.com/solana/MintA',
      }),
    });
    const monitor = new ActivityFeedMonitor(deps);

    await monitor.tick();
    vi.setSystemTime(new Date('2026-07-27T08:16:00Z'));
    await monitor.tick();

    const sendPhoto = (deps as { bot: { api: { sendPhoto: ReturnType<typeof vi.fn> } } }).bot.api
      .sendPhoto;
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendPhoto.mock.calls[0]?.[1]).toBe('https://example.com/logo.png');
  });
});

describe('ActivityFeedMonitor — trending token requires a live, real threshold', () => {
  it('does not post a bot-detected token whose live 1h price change is below the trending bar', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const prisma = fakePrisma({
      token: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'tok1',
            mint: 'MintA',
            name: 'A',
            symbol: 'AAA',
            dex: 'RAYDIUM',
            firstSeenAt: new Date('2026-07-27T07:00:00Z'),
          },
        ]),
      },
    });
    const deps = fakeDeps({
      prisma,
      deployedAt: new Date('2026-07-27T08:00:00Z'),
      marketData: fakeMarketData({ priceChangeH1Percent: 3, chain: 'Solana', dexScreenerUrl: 'x' }),
    });
    const monitor = new ActivityFeedMonitor(deps);
    await monitor.tick();
    vi.setSystemTime(new Date('2026-07-27T08:16:00Z'));
    await monitor.tick();
    // NEW_OPPORTUNITY has real backlog too (deployedAt allows it), so assert
    // specifically that no TRENDING TOKEN message went out.
    const sendMessage = (deps as { bot: { api: { sendMessage: ReturnType<typeof vi.fn> } } }).bot
      .api.sendMessage;
    const trendingCalls = sendMessage.mock.calls.filter((c) =>
      (c[1] as string).includes('TRENDING TOKEN'),
    );
    expect(trendingCalls).toHaveLength(0);
  });
});

describe('ActivityFeedMonitor — daily cap', () => {
  it('stops posting once maxPostsPerDay is reached for the current UTC day', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const prisma = fakePrisma({
      token: {
        findMany: vi.fn().mockResolvedValue(
          Array.from({ length: 10 }, (_, i) => ({
            id: `tok${i}`,
            mint: `Mint${i}`,
            name: 'Example',
            symbol: 'EXA',
            dex: 'RAYDIUM',
            liquidityUsd: 1000,
            marketCapUsd: 5000,
            aiScore: 90,
            firstSeenAt: new Date('2026-07-27T07:00:00Z'),
          })),
        ),
      },
    });
    const deps = fakeDeps({ prisma, maxPostsPerDay: 2 });
    const monitor = new ActivityFeedMonitor(deps);

    let t = new Date('2026-07-27T08:00:00Z').getTime();
    await monitor.tick(); // schedules first delay
    for (let i = 0; i < 5; i++) {
      t += 16 * 60_000;
      vi.setSystemTime(new Date(t));
      await monitor.tick();
    }

    const sendMessage = (deps as { bot: { api: { sendMessage: ReturnType<typeof vi.fn> } } }).bot
      .api.sendMessage;
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
