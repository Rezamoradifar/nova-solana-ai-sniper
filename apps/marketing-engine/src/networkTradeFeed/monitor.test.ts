import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkTradeFeedMonitor } from './monitor.js';

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
    user: { findMany: vi.fn().mockResolvedValue([]) },
    networkTradeBroadcast: { create: vi.fn().mockResolvedValue({ id: 'broadcast1' }) },
    networkTradeBroadcastDelivery: { createMany: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  } as never;
}

function fakeMarketData(enrichment: unknown = undefined) {
  return { fetchEnrichment: vi.fn().mockResolvedValue(enrichment) } as never;
}

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
  const sendPhoto = vi
    .fn()
    .mockResolvedValue({ message_id: 1, photo: [{ file_id: 'sm_1' }, { file_id: 'lg_1' }] });
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

  it('shows a loss header for a net-negative trade inside the -20%/-25% loss band', async () => {
    const row = fakeRow({ realizedRoiPercent: -22, realizedPnlUsd: -80, realizedPnlSol: -0.4 });
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

  it('still posts a generated card photo (never falls back to text) when live enrichment/logo lookup fails', async () => {
    // fakeDeps' default fakeMarketData resolves `undefined` — same as a real
    // failed DexScreener lookup. renderNetworkTradeCard never throws (see its
    // own tests), so the post still goes out as a photo with "N/A" fields,
    // never degrading to a text-only sendMessage.
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([fakeRow()]) },
    });
    const deps = fakeDeps({ prisma });
    const monitor = new NetworkTradeFeedMonitor(deps);

    await monitor.tick();
    vi.setSystemTime(new Date('2026-08-02T08:16:00Z'));
    await monitor.tick();

    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(1);
    expect(bot(deps).sendMessage).not.toHaveBeenCalled();
  });
});

describe('NetworkTradeFeedMonitor — bot+channel parity', () => {
  it('enqueues a DM broadcast to registered users with the exact channel fileId/caption/buttons', async () => {
    const broadcastCreate = vi.fn().mockResolvedValue({ id: 'broadcast1' });
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([fakeRow()]) },
      networkTradeBroadcast: { create: broadcastCreate },
    });
    const deps = fakeDeps({ prisma });
    const monitor = new NetworkTradeFeedMonitor(deps);

    await monitor.tick();
    vi.setSystemTime(new Date('2026-08-02T08:16:00Z'));
    await monitor.tick();

    expect(broadcastCreate).toHaveBeenCalledTimes(1);
    const call = broadcastCreate.mock.calls[0]![0];
    expect(call.data.entryId).toBe('entry1');
    // The largest (last) photo size from the channel's own sendPhoto result —
    // never a re-render.
    expect(call.data.photoFileId).toBe('lg_1');
    const [, , sentOpts] = bot(deps).sendPhoto.mock.calls[0]!;
    expect(call.data.caption).toBe(sentOpts.caption);
  });

  it('never re-throws (and never blocks the dedup write) when the broadcast enqueue itself fails', async () => {
    const broadcastCreate = vi.fn().mockRejectedValue(new Error('db down'));
    const activityFeedPostCreate = vi.fn().mockResolvedValue(undefined);
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([fakeRow()]) },
      networkTradeBroadcast: { create: broadcastCreate },
      activityFeedPost: {
        findMany: vi.fn().mockResolvedValue([]),
        create: activityFeedPostCreate,
      },
    });
    const deps = fakeDeps({ prisma });
    const monitor = new NetworkTradeFeedMonitor(deps);

    await monitor.tick();
    vi.setSystemTime(new Date('2026-08-02T08:16:00Z'));
    await monitor.tick();

    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(1);
    expect(activityFeedPostCreate).toHaveBeenCalledWith({
      data: { feedType: 'NETWORK_TRADE', refId: 'entry1' },
    });
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

describe('NetworkTradeFeedMonitor — ROI quota buckets', () => {
  it('never posts a candidate whose ROI falls outside the three spec bands', async () => {
    const row = fakeRow({ realizedRoiPercent: -10 }); // small loss — no bucket
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([row]) },
    });
    const deps = fakeDeps({ prisma });
    const monitor = new NetworkTradeFeedMonitor(deps);

    await monitor.tick();
    vi.setSystemTime(new Date('2026-08-02T08:16:00Z'));
    await monitor.tick();

    expect(bot(deps).sendPhoto).not.toHaveBeenCalled();
  });

  it('stops posting HIGH_PROFIT candidates once that bucket hits its own 20/day cap, even though maxPostsPerDay allows more', async () => {
    // Longer timeout: 25 ticks each render a real PNG card end-to-end.
    let counter = 0;
    const findMany = vi.fn().mockImplementation(() => {
      counter += 1;
      return Promise.resolve([
        fakeRow({ id: `entry${counter}`, mint: `Mint${counter}`, realizedRoiPercent: 80 }),
      ]);
    });
    const prisma = fakePrisma({ smartWalletTokenEntry: { findMany } });
    const deps = fakeDeps({
      prisma,
      maxPostsPerDay: 30,
      minIntervalMinutes: 1,
      maxIntervalMinutes: 2,
    });
    const monitor = new NetworkTradeFeedMonitor(deps);

    let t = new Date('2026-08-02T08:00:00Z').getTime();
    for (let i = 0; i < 25; i++) {
      vi.setSystemTime(new Date(t));
      await monitor.tick();
      t += 3 * 60_000;
    }

    // 25 real HIGH_PROFIT candidates were offered, but the bucket's own cap
    // (20) — not the overall maxPostsPerDay ceiling (30) — is what stops it.
    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(20);
  }, 20_000);

  it('posts SMALL_PROFIT and LOSS_BAND candidates independently even once the HIGH_PROFIT bucket is full', async () => {
    const rows = [
      fakeRow({ id: 'hp', mint: 'MintHP', realizedRoiPercent: 80 }),
      fakeRow({ id: 'sp', mint: 'MintSP', realizedRoiPercent: 10 }),
      fakeRow({ id: 'loss', mint: 'MintLoss', realizedRoiPercent: -22 }),
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    const activityFeedFindMany = vi.fn().mockResolvedValue([]);
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany },
      activityFeedPost: { findMany: activityFeedFindMany, create: vi.fn() },
    });
    const deps = fakeDeps({ prisma, maxPostsPerDay: 30 });
    const monitor = new NetworkTradeFeedMonitor(deps);

    await monitor.tick();
    // Best-scored real candidate (highest ROI/PnL) among all three eligible
    // buckets is picked first — the HIGH_PROFIT one.
    vi.setSystemTime(new Date('2026-08-02T08:16:00Z'));
    await monitor.tick();
    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(1);

    // 'hp' is now posted (dedup row exists), so the next tick's real,
    // unposted backlog is just the small-profit + loss rows — both still in
    // open buckets — and the higher-scored of the two (small profit, 10%
    // ROI beats a loss) goes out next.
    activityFeedFindMany.mockResolvedValue([{ refId: 'hp' }]);
    vi.setSystemTime(new Date('2026-08-02T08:40:00Z'));
    await monitor.tick();
    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(2);
  });
});
