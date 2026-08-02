import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EcosystemFeedMonitor, type EcosystemFeedMonitorDeps } from './monitor.js';

const renderTokenStatCardMock = vi.fn().mockResolvedValue(Buffer.from('fake-png'));
vi.mock('../visuals/tokenStatCard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../visuals/tokenStatCard.js')>();
  return {
    ...actual,
    renderTokenStatCard: (...args: unknown[]) => renderTokenStatCardMock(...args),
  };
});

const fetchMessagesMock = vi.fn().mockResolvedValue([]);
vi.mock('../discovery/telegramTrend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery/telegramTrend.js')>();
  return {
    ...actual,
    EcosystemTelegramTrendClient: vi.fn().mockImplementation(() => ({
      fetchMessages: fetchMessagesMock,
    })),
  };
});

const scoreTokenRiskMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../discovery/riskScore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery/riskScore.js')>();
  return { ...actual, scoreTokenRisk: (...args: unknown[]) => scoreTokenRiskMock(...args) };
});

const resolveTradePhotoMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@nova/telegram-bot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nova/telegram-bot')>();
  return { ...actual, resolveTradePhoto: (...args: unknown[]) => resolveTradePhotoMock(...args) };
});

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    token: { findMany: vi.fn().mockResolvedValue([]) },
    smartWalletTokenEntry: { findMany: vi.fn().mockResolvedValue([]) },
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

function fakeDeps(overrides: Record<string, unknown> = {}): EcosystemFeedMonitorDeps {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
  const sendPhoto = vi.fn().mockResolvedValue({ message_id: 1 });
  const getMe = vi.fn().mockResolvedValue({ username: 'novasniperbot' });
  return {
    prisma: fakePrisma(),
    bot: { api: { sendMessage, sendPhoto, getMe } },
    chatId: '@testchannel',
    logger: fakeLogger(),
    connection: {} as never,
    marketData: fakeMarketData(),
    deployedAt: new Date('2020-01-01T00:00:00Z'),
    telegramChannels: [],
    minLiquidityUsd: 1000,
    minRiskScore: 50,
    minVolumeUsd: 10_000,
    maxHiddenGemMarketCapUsd: 200_000,
    maxCandidatesPerTick: 5,
    maxPostsPerTick: 3,
    ...overrides,
  } as unknown as EcosystemFeedMonitorDeps;
}

function bot(deps: EcosystemFeedMonitorDeps) {
  return (
    deps as unknown as {
      bot: { api: { sendPhoto: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> } };
    }
  ).bot.api;
}

beforeEach(() => {
  vi.clearAllMocks();
  renderTokenStatCardMock.mockResolvedValue(Buffer.from('fake-png'));
  fetchMessagesMock.mockResolvedValue([]);
  scoreTokenRiskMock.mockResolvedValue(undefined);
  resolveTradePhotoMock.mockResolvedValue(undefined);
});

describe('EcosystemFeedMonitor — no real backlog', () => {
  it('posts nothing when every category is empty', async () => {
    const deps = fakeDeps();
    const monitor = new EcosystemFeedMonitor(deps);
    await monitor.tick();
    expect(bot(deps).sendPhoto).not.toHaveBeenCalled();
    expect(bot(deps).sendMessage).not.toHaveBeenCalled();
  });
});

describe('EcosystemFeedMonitor — Hidden Gem', () => {
  it('posts a hidden gem candidate as an HTML photo and marks the dedup row', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const prisma = fakePrisma({
      // Trending/High Volume/Hidden Gem all call prisma.token.findMany with a
      // different `where` — route by shape so only the Hidden Gem query (the
      // only one that filters on marketCapUsd) sees this candidate, same as
      // real Prisma's where-filtering would.
      token: {
        findMany: vi.fn().mockImplementation((args: { where: Record<string, unknown> }) => {
          if (!('marketCapUsd' in args.where)) return Promise.resolve([]);
          return Promise.resolve([
            {
              id: 'tok1',
              mint: 'MintGem',
              name: 'Gem',
              symbol: 'GEM',
              dex: 'PUMPFUN',
              firstSeenAt: new Date(),
              marketCapUsd: 50_000,
              liquidityUsd: 8_000,
              aiScore: 70,
              mintAuthorityRevoked: true,
              freezeAuthorityRevoked: true,
              top10HolderPercent: 10,
            },
          ]);
        }),
      },
      activityFeedPost: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        create,
      },
    });
    // maxPostsPerTick: 1 — this test's static mock always returns the same
    // candidate (no real dedup persistence to simulate the row markEcosystemFeedPosted
    // just wrote), so with the default cap of 3 it would post the same
    // candidate 3 times. The multi-post-per-tick loop itself is covered by
    // the dedicated "per-tick cap" test below; this one only verifies a
    // single post's content.
    const deps = fakeDeps({ prisma, maxPostsPerTick: 1 });
    const monitor = new EcosystemFeedMonitor(deps);

    await monitor.tick();

    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(1);
    const [, , opts] = bot(deps).sendPhoto.mock.calls[0]!;
    expect(opts.parse_mode).toBe('HTML');
    expect(opts.caption).toContain('HIDDEN GEM');
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ feedType: 'ECOSYSTEM_HIDDEN_GEM' }),
    });
  });
});

describe('EcosystemFeedMonitor — High Volume Tokens', () => {
  it('does not post a candidate whose live volume is below the configured floor', async () => {
    const prisma = fakePrisma({
      // Only the High Volume query should see this candidate — routed by
      // absence of the marketCapUsd where-filter (Hidden Gem's own marker,
      // see the Hidden Gem test above) so Trending's identical-shaped query
      // doesn't also pick it up and confuse this test's assertion.
      token: {
        findMany: vi
          .fn()
          .mockImplementation(
            (args: { where: Record<string, unknown>; orderBy: { firstSeenAt: string } }) => {
              if ('marketCapUsd' in args.where) return Promise.resolve([]);
              return Promise.resolve([
                {
                  id: 'tok1',
                  mint: 'MintA',
                  name: 'A',
                  symbol: 'AAA',
                  dex: 'RAYDIUM',
                  firstSeenAt: new Date(),
                },
              ]);
            },
          ),
      },
    });
    const deps = fakeDeps({
      prisma,
      minVolumeUsd: 100_000,
      marketData: fakeMarketData({
        liquidityUsd: 5000,
        marketCapUsd: 10_000,
        volume24hUsd: 500, // below the floor
        priceChangeH1Percent: 5,
        chain: 'Solana',
        dexScreenerUrl: 'x',
      }),
    });
    const monitor = new EcosystemFeedMonitor(deps);

    await monitor.tick();

    expect(bot(deps).sendPhoto).not.toHaveBeenCalled();
  });
});

describe('EcosystemFeedMonitor — Biggest Winners', () => {
  it('reuses resolveTradePhoto and posts with the real trade caption', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const prisma = fakePrisma({
      position: {
        findMany: vi.fn().mockResolvedValue([{ id: 'pos1', realizedPnlUsd: 850 }]),
        // resolveShowcaseTradeByPositionId needs the position's own
        // createdAt/closedAt/token/amountSolInvested — supply a fuller
        // position record for that resolution path.
        findUnique: vi.fn().mockResolvedValue({
          id: 'pos1',
          walletId: 'w1',
          tokenId: 't1',
          createdAt: new Date('2026-07-30T00:00:00Z'),
          closedAt: new Date('2026-07-31T00:00:00Z'),
          entryPriceUsd: 0.001,
          amountSolInvested: 1,
          realizedPnlUsd: 850,
          riskScoreAtEntry: 82,
          token: { mint: 'MintA', name: 'A', symbol: 'AAA', dex: 'RAYDIUM' },
        }),
      },
      trade: {
        findFirst: vi.fn().mockResolvedValue({ createdAt: new Date(), txSignature: 'buysig' }),
        findMany: vi
          .fn()
          .mockResolvedValue([
            { amountSol: 2, createdAt: new Date(), txSignature: 'sellsig', priceUsd: 0.005 },
          ]),
      },
      activityFeedPost: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        create,
      },
    });
    resolveTradePhotoMock.mockResolvedValueOnce({ buffer: Buffer.from('chart') });

    const deps = fakeDeps({ prisma });
    const monitor = new EcosystemFeedMonitor(deps);

    await monitor.tick();

    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(1);
    const [, , opts] = bot(deps).sendPhoto.mock.calls[0]!;
    expect(opts.caption).toMatch(/BIGGEST PROFIT|MASSIVE ROI/);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ feedType: 'ECOSYSTEM_BIGGEST_WINNER', refId: 'pos1' }),
    });
  });
});

describe('EcosystemFeedMonitor — Telegram-discovered Trending Token', () => {
  it('never posts a discovered mint that fails the liquidity floor, even with no risk score call', async () => {
    fetchMessagesMock.mockResolvedValueOnce([
      {
        channel: 'trendingssol',
        messageId: 1,
        messageUrl: 'x',
        mints: ['DiscoveredMint111111111111111111111111111'],
      },
    ]);
    const deps = fakeDeps({
      telegramChannels: ['trendingssol'],
      marketData: fakeMarketData({ liquidityUsd: 10, chain: 'Solana', dexScreenerUrl: 'x' }),
    });
    const monitor = new EcosystemFeedMonitor(deps);

    await monitor.tick();

    expect(scoreTokenRiskMock).not.toHaveBeenCalled();
    expect(bot(deps).sendPhoto).not.toHaveBeenCalled();
  });

  it('posts a discovered mint once it clears both the liquidity and risk-score gates', async () => {
    fetchMessagesMock.mockResolvedValueOnce([
      {
        channel: 'trendingssol',
        messageId: 1,
        messageUrl: 'x',
        mints: ['DiscoveredMint111111111111111111111111111'],
      },
    ]);
    scoreTokenRiskMock.mockResolvedValueOnce({
      score: 80,
      flags: {
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        top10HolderPercent: 5,
        liquidityUsd: 5000,
      },
    });
    const create = vi.fn().mockResolvedValue(undefined);
    const prisma = fakePrisma({
      activityFeedPost: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        create,
      },
    });
    const deps = fakeDeps({
      prisma,
      telegramChannels: ['trendingssol'],
      marketData: fakeMarketData({
        liquidityUsd: 5000,
        marketCapUsd: 20_000,
        volume24hUsd: 1000,
        chain: 'Solana',
        dexScreenerUrl: 'x',
      }),
    });
    const monitor = new EcosystemFeedMonitor(deps);

    await monitor.tick();

    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ feedType: 'ECOSYSTEM_TRENDING_TOKEN' }),
    });
  });
});

describe('EcosystemFeedMonitor — per-tick cap', () => {
  it('never posts more than maxPostsPerTick events in a single tick', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const prisma = fakePrisma({
      token: {
        findMany: vi.fn().mockResolvedValue(
          Array.from({ length: 5 }, (_, i) => ({
            id: `tok${i}`,
            mint: `Mint${i}`,
            name: 'Gem',
            symbol: 'GEM',
            dex: 'PUMPFUN',
            firstSeenAt: new Date(),
            marketCapUsd: 50_000,
            liquidityUsd: 8_000,
            aiScore: 70,
            mintAuthorityRevoked: true,
            freezeAuthorityRevoked: true,
            top10HolderPercent: 10,
          })),
        ),
      },
      activityFeedPost: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        create,
      },
    });
    const deps = fakeDeps({ prisma, maxPostsPerTick: 2 });
    const monitor = new EcosystemFeedMonitor(deps);

    await monitor.tick();

    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(2);
  });
});

describe('EcosystemFeedMonitor — overlapping ticks', () => {
  it('guards against overlapping ticks', async () => {
    const deps = fakeDeps();
    const monitor = new EcosystemFeedMonitor(deps);
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    (deps.marketData as unknown as { fetchEnrichment: ReturnType<typeof vi.fn> }).fetchEnrichment =
      vi.fn().mockImplementationOnce(async () => {
        await gate;
        return undefined;
      });
    // Give it something to iterate on so fetchEnrichment is actually reached during discovery.
    fetchMessagesMock.mockResolvedValueOnce([
      {
        channel: 'x',
        messageId: 1,
        messageUrl: 'x',
        mints: ['DiscoveredMint111111111111111111111111111'],
      },
    ]);
    const depsWithChannel = fakeDeps({ telegramChannels: ['x'], marketData: deps.marketData });

    const monitor2 = new EcosystemFeedMonitor(depsWithChannel);
    const first = monitor2.tick();
    const second = monitor2.tick();
    releaseFirst();
    await Promise.all([first, second]);

    expect(fetchMessagesMock).toHaveBeenCalledTimes(1);
    void monitor; // unused placeholder to keep the first monitor construction meaningful
  });
});
