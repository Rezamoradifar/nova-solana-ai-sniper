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

function fakeMarketDataByMint(byMint: Record<string, unknown>) {
  return {
    fetchEnrichment: vi.fn((mint: string) => Promise.resolve(byMint[mint])),
  } as never;
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

describe('NetworkTradeFeedMonitor — posts the highest-priority candidate', () => {
  it('picks the higher-ROI of two same-tier candidates and marks its dedup row', async () => {
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

  it('shows a loss header for a net-negative trade within the acceptable small-loss range', async () => {
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

describe('NetworkTradeFeedMonitor — quality gate (spam/rugs)', () => {
  it('posts a candidate with a small, acceptable loss', async () => {
    const row = fakeRow({ realizedRoiPercent: -10, realizedPnlUsd: -20 });
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([row]) },
    });
    const deps = fakeDeps({ prisma });
    const monitor = new NetworkTradeFeedMonitor(deps);

    await monitor.tick();
    vi.setSystemTime(new Date('2026-08-02T08:16:00Z'));
    await monitor.tick();

    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(1);
  });

  it('never posts a candidate whose loss is steep enough to read as a rug (worse than -30%)', async () => {
    const row = fakeRow({ realizedRoiPercent: -85, realizedPnlUsd: -850 });
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

  it('never posts a candidate from a wallet with a high historical rug-exposure rate, even on a winning trade', async () => {
    const row = fakeRow({ wallet: { confidenceScore: 65, rugExposureRatePct: 80 } });
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

  it('never posts a candidate from a wallet flagged as a likely Sybil/wash-trading cluster', async () => {
    const row = fakeRow({ wallet: { confidenceScore: 65, sybilConfidencePct: 90 } });
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
});

describe('NetworkTradeFeedMonitor — priority order (Trending > Smart Money > Whale > ROI > PnL)', () => {
  it('picks the Trending Tokens candidate over a Smart Money candidate with a far higher ROI', async () => {
    const trending = fakeRow({
      id: 'trend',
      mint: 'MintTrend',
      realizedRoiPercent: 5,
      realizedPnlUsd: 5,
      wallet: { confidenceScore: 0 },
    });
    const smartMoney = fakeRow({
      id: 'sm',
      mint: 'MintSM',
      realizedRoiPercent: 900,
      realizedPnlUsd: 9000,
      wallet: { confidenceScore: 90 },
    });
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([trending, smartMoney]) },
    });
    const deps = fakeDeps({
      prisma,
      marketData: fakeMarketDataByMint({ MintTrend: { volume24hUsd: 500_000 } }),
    });
    const monitor = new NetworkTradeFeedMonitor(deps);

    await monitor.tick();
    vi.setSystemTime(new Date('2026-08-02T08:16:00Z'));
    await monitor.tick();

    const create = (prisma as unknown as { activityFeedPost: { create: ReturnType<typeof vi.fn> } })
      .activityFeedPost.create;
    expect(create).toHaveBeenCalledWith({ data: { feedType: 'NETWORK_TRADE', refId: 'trend' } });
  });

  it('picks a Whale Wallet candidate (large real entry) over a plain higher-ROI candidate that clears no category', async () => {
    const whale = fakeRow({
      id: 'whale',
      mint: 'MintWhale',
      entryAmountSol: 12,
      realizedRoiPercent: 20,
      wallet: { confidenceScore: 0 },
    });
    const plain = fakeRow({
      id: 'plain',
      mint: 'MintPlain',
      entryAmountSol: 0.2,
      realizedRoiPercent: 400,
      wallet: { confidenceScore: 0 },
    });
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([whale, plain]) },
    });
    const deps = fakeDeps({ prisma });
    const monitor = new NetworkTradeFeedMonitor(deps);

    await monitor.tick();
    vi.setSystemTime(new Date('2026-08-02T08:16:00Z'));
    await monitor.tick();

    const create = (prisma as unknown as { activityFeedPost: { create: ReturnType<typeof vi.fn> } })
      .activityFeedPost.create;
    expect(create).toHaveBeenCalledWith({ data: { feedType: 'NETWORK_TRADE', refId: 'whale' } });
  });
});

describe('NetworkTradeFeedMonitor — duplicate-wallet cooldown', () => {
  it('skips a second real trade from the same wallet within the cooldown window, then allows it again once the cooldown elapses', async () => {
    const sameWallet = 'WalletRepeat1111111111111111111111111111111';
    const first = fakeRow({ id: 'first', mint: 'MintFirst', walletAddress: sameWallet });
    const second = fakeRow({ id: 'second', mint: 'MintSecond', walletAddress: sameWallet });

    const activityFeedFindMany = vi.fn().mockResolvedValue([]);
    const findMany = vi.fn().mockResolvedValue([first]);
    const prisma = fakePrisma({
      smartWalletTokenEntry: { findMany },
      activityFeedPost: { findMany: activityFeedFindMany, create: vi.fn() },
    });
    const deps = fakeDeps({ prisma, minIntervalMinutes: 1, maxIntervalMinutes: 2 });
    const monitor = new NetworkTradeFeedMonitor(deps);

    await monitor.tick();
    vi.setSystemTime(new Date('2026-08-02T08:02:00Z'));
    await monitor.tick();
    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(1);

    // 'first' is now posted (dedup row exists); the real backlog is just
    // 'second', from the SAME wallet — skipped this tick despite being a
    // real, quality-eligible, unposted trade, because that wallet was just
    // featured.
    activityFeedFindMany.mockResolvedValue([{ refId: 'first' }]);
    findMany.mockResolvedValue([second]);
    vi.setSystemTime(new Date('2026-08-02T08:05:00Z'));
    await monitor.tick();
    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(1);

    // Once the 3h cooldown has elapsed, the same wallet's next real trade is
    // eligible again.
    vi.setSystemTime(new Date('2026-08-02T11:10:00Z'));
    await monitor.tick();
    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(2);
  });
});

describe('NetworkTradeFeedMonitor — scheduler cadence', () => {
  it('schedules each next check 20-40 minutes out, never at a fixed interval', async () => {
    const deps = fakeDeps({ minIntervalMinutes: 20, maxIntervalMinutes: 40 });
    const monitor = new NetworkTradeFeedMonitor(deps);

    const randomSpy = vi.spyOn(Math, 'random');
    randomSpy.mockReturnValueOnce(0);
    await monitor.tick();
    const firstDueAt = (monitor as unknown as { nextPostDueAt: number }).nextPostDueAt;
    expect(firstDueAt - Date.now()).toBe(20 * 60_000);

    vi.setSystemTime(new Date('2026-08-02T09:00:00Z'));
    randomSpy.mockReturnValueOnce(1);
    await monitor.tick();
    const secondDueAt = (monitor as unknown as { nextPostDueAt: number }).nextPostDueAt;
    expect(secondDueAt - Date.now()).toBe(40 * 60_000);

    // Different random draws produce different absolute times — this is what
    // keeps consecutive posts from ever landing at exactly the same time.
    expect(firstDueAt).not.toBe(secondDueAt);
  });
});
