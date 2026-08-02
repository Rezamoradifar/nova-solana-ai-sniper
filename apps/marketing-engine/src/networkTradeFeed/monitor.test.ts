import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkTradeFeedMonitor } from './monitor.js';

const resolveTradePhotoMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@nova/telegram-bot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nova/telegram-bot')>();
  return { ...actual, resolveTradePhoto: (...args: unknown[]) => resolveTradePhotoMock(...args) };
});

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry1',
    mint: 'MintA',
    walletAddress: 'WalletAAAA1111111111111111111111111111111',
    entryAt: new Date('2026-08-01T00:00:00Z'),
    exitAt: new Date('2026-08-01T02:00:00Z'),
    entrySignature: 'buysig',
    exitSignature: 'sellsig',
    entryPriceUsd: 0.001,
    exitPriceUsd: 0.002,
    entryAmountSol: 1,
    exitAmountSol: 1.8,
    realizedRoiPercent: 80,
    realizedPnlSol: 0.8,
    realizedPnlUsd: 150,
    token: { name: 'Gigachad', symbol: 'GIGA', dex: 'PUMPFUN', aiScore: 72 },
    wallet: { confidenceScore: 65 },
    ...overrides,
  };
}

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([]) },
    activityFeedPost: {
      findMany: vi.fn().mockResolvedValue([]),
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
  const getMe = vi.fn().mockResolvedValue({ username: 'novasniperbot' });
  return {
    prisma: fakePrisma(),
    bot: { api: { sendMessage, sendPhoto, getMe } },
    chatId: '@testchannel',
    logger: fakeLogger(),
    marketData: fakeMarketData(),
    deployedAt: new Date('2020-01-01T00:00:00Z'),
    minIntervalMinutes: 15,
    maxIntervalMinutes: 60,
    maxPostsPerDay: 20,
    ...overrides,
  } as never;
}

function bot(deps: unknown) {
  return (
    deps as {
      bot: { api: { sendPhoto: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> } };
    }
  ).bot.api;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-02T08:00:00Z'));
  resolveTradePhotoMock.mockResolvedValue({ buffer: Buffer.from('chart') });
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NetworkTradeFeedMonitor — no burst on first tick', () => {
  it('schedules the first random delay instead of posting immediately', async () => {
    const deps = fakeDeps();
    const monitor = new NetworkTradeFeedMonitor(deps);
    await monitor.tick();
    expect(bot(deps).sendPhoto).not.toHaveBeenCalled();
  });
});

describe('NetworkTradeFeedMonitor — no real backlog', () => {
  it('posts nothing when there are no real, unposted completed trades', async () => {
    const deps = fakeDeps();
    const monitor = new NetworkTradeFeedMonitor(deps);
    await monitor.tick();
    vi.setSystemTime(new Date('2026-08-02T08:16:00Z'));
    await monitor.tick();
    expect(bot(deps).sendPhoto).not.toHaveBeenCalled();
  });
});

describe('NetworkTradeFeedMonitor — posts the best-scored candidate', () => {
  it('picks the higher-scored of two candidates and marks its dedup row', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const strongRow = fakeRow({ id: 'strong', realizedRoiPercent: 300, realizedPnlUsd: 4000 });
    const weakRow = fakeRow({
      id: 'weak',
      mint: 'MintB',
      realizedRoiPercent: 5,
      realizedPnlUsd: 10,
    });
    const findMany = vi.fn().mockResolvedValue([weakRow, strongRow]);
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany },
      activityFeedPost: { findMany: vi.fn().mockResolvedValue([]), create },
    });
    const deps = fakeDeps({ prisma });
    const monitor = new NetworkTradeFeedMonitor(deps);

    await monitor.tick();
    vi.setSystemTime(new Date('2026-08-02T08:16:00Z'));
    await monitor.tick();

    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(1);
    const [, , opts] = bot(deps).sendPhoto.mock.calls[0]!;
    expect(opts.caption).toContain('PROFIT');
    expect(opts.parse_mode).toBe('HTML');
    expect(create).toHaveBeenCalledWith({
      data: { feedType: 'NETWORK_TRADE', refId: 'strong' },
    });
  });

  it('shows a loss header for a net-negative trade', async () => {
    const row = fakeRow({ realizedRoiPercent: -60, realizedPnlUsd: -80, realizedPnlSol: -0.4 });
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([row]) },
    });
    const deps = fakeDeps({ prisma });
    const monitor = new NetworkTradeFeedMonitor(deps);

    await monitor.tick();
    vi.setSystemTime(new Date('2026-08-02T08:16:00Z'));
    await monitor.tick();

    const [, , opts] = bot(deps).sendPhoto.mock.calls[0]!;
    expect(opts.caption).toContain('LOSS');
  });

  it('falls back to a text-only message when no real chart photo resolves', async () => {
    resolveTradePhotoMock.mockResolvedValueOnce(undefined);
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([fakeRow()]) },
    });
    const deps = fakeDeps({ prisma });
    const monitor = new NetworkTradeFeedMonitor(deps);

    await monitor.tick();
    vi.setSystemTime(new Date('2026-08-02T08:16:00Z'));
    await monitor.tick();

    expect(bot(deps).sendPhoto).not.toHaveBeenCalled();
    expect(bot(deps).sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('NetworkTradeFeedMonitor — daily cap', () => {
  it('stops posting once maxPostsPerDay is reached for the current UTC day', async () => {
    let counter = 0;
    const findMany = vi.fn().mockImplementation(() => {
      counter += 1;
      return Promise.resolve([fakeRow({ id: `entry${counter}`, mint: `Mint${counter}` })]);
    });
    const prisma = fakePrisma({ smartWalletTokenEntry: { findMany } });
    const deps = fakeDeps({
      prisma,
      maxPostsPerDay: 1,
      minIntervalMinutes: 1,
      maxIntervalMinutes: 2,
    });
    const monitor = new NetworkTradeFeedMonitor(deps);

    let t = new Date('2026-08-02T08:00:00Z').getTime();
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(new Date(t));
      await monitor.tick();
      t += 3 * 60_000;
    }

    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(1);
  });
});
