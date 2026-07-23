import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from '@nova/shared';

const generateUniquePost = vi.fn();
const fetchMarketContext = vi.fn();
const formatMarketFacts = vi.fn();
const publishPost = vi.fn();
const buildButtons = vi.fn(() => []);
const pickNextCategory = vi.fn();
const generateVisual = vi.fn();
const saveGeneratedImage = vi.fn();
const selectHashtags = vi.fn(() => ['#Solana', '#Crypto', '#NovaSolanaAI']);

vi.mock('./generator.js', () => ({ generateUniquePost }));
vi.mock('./marketContext.js', () => ({ fetchMarketContext, formatMarketFacts }));
vi.mock('./buttons.js', () => ({ buildButtons }));
vi.mock('./categories.js', () => ({ pickNextCategory }));
vi.mock('./hashtags.js', () => ({ selectHashtags }));
vi.mock('./visuals/render.js', () => ({ generateVisual }));
vi.mock('./visuals/imageStore.js', () => ({ saveGeneratedImage }));
vi.mock('@nova/telegram-bot', () => ({ publishPost }));

const { runOnce } = await import('./runner.js');

const fakeLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const GENERATED = {
  category: 'trading_tips' as const,
  titleEn: 'EN title',
  bodyEn: 'EN body',
  titleFa: 'عنوان',
  bodyFa: 'متن',
  contentHash: 'hash-1',
};

function fakePrisma(
  opts: { recentPosts?: unknown[]; recentImages?: { imageContentHash: string }[] } = {},
) {
  const findMany = vi.fn().mockImplementation((args: { select?: Record<string, boolean> }) => {
    if (args?.select?.imageContentHash) return Promise.resolve(opts.recentImages ?? []);
    return Promise.resolve(opts.recentPosts ?? []);
  });
  return {
    marketingPost: {
      findMany,
      findUnique: vi.fn().mockResolvedValue(null),
      // Echoes back whatever `data` the caller passed, same as real Prisma's
      // create() returning the actual created row — a static mock here would
      // silently hide bugs where a field is computed but never wired into
      // the create() call.
      create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => ({
        id: 'post-1',
        ...args.data,
      })),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

function baseDeps(prisma = fakePrisma()) {
  return {
    prisma: prisma as never,
    provider: { name: 'gemini', generateText: vi.fn() } as never,
    bot: {} as never,
    chatId: '@SolanaSniperAI',
    buttonContext: {} as never,
    logger: fakeLogger,
    aiImageEnabled: false,
    imageProvider: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  generateUniquePost.mockResolvedValue(GENERATED);
  publishPost.mockResolvedValue({ messageId: 4242 });
  fetchMarketContext.mockResolvedValue({});
  formatMarketFacts.mockReturnValue(undefined);
  pickNextCategory.mockReturnValue('trading_tips');
  generateVisual.mockResolvedValue(undefined);
  saveGeneratedImage.mockResolvedValue('/path/to/generated-images/trading_tips-123-abcd.png');
});

describe('runOnce', () => {
  it('creates, publishes, and marks the post published (with the Telegram message id persisted), returning the message id', async () => {
    const prisma = fakePrisma();
    const result = await runOnce(baseDeps(prisma));

    expect(prisma.marketingPost.create).toHaveBeenCalledTimes(1);
    expect(publishPost).toHaveBeenCalledTimes(1);
    expect(prisma.marketingPost.update).toHaveBeenCalledWith({
      where: { id: 'post-1' },
      data: { publishedAt: expect.any(Date), telegramMessageId: 4242 },
    });
    expect(result).toEqual({ postId: 'post-1', category: 'trading_tips', messageId: 4242 });
  });

  it('returns undefined and never publishes when no unique content could be generated', async () => {
    generateUniquePost.mockResolvedValue(undefined);
    const prisma = fakePrisma();

    const result = await runOnce(baseDeps(prisma));

    expect(result).toBeUndefined();
    expect(prisma.marketingPost.create).not.toHaveBeenCalled();
    expect(publishPost).not.toHaveBeenCalled();
  });

  it('fetches and injects market facts for a market-relevant category', async () => {
    pickNextCategory.mockReturnValue('market_updates');
    formatMarketFacts.mockReturnValue('SOL price change (24h): +4.2%');

    await runOnce(baseDeps());

    expect(fetchMarketContext).toHaveBeenCalledTimes(1);
    const call = generateUniquePost.mock.calls[0]!;
    expect(call[5]).toBe('SOL price change (24h): +4.2%');
  });

  it('skips fetching market facts entirely for a non-market category', async () => {
    pickNextCategory.mockReturnValue('referral');

    await runOnce(baseDeps());

    expect(fetchMarketContext).not.toHaveBeenCalled();
    const call = generateUniquePost.mock.calls[0]!;
    expect(call[5]).toBeUndefined();
  });

  it('passes recent published post texts through to generateUniquePost for near-duplicate checking', async () => {
    const recentPosts = [{ titleEn: 'A', bodyEn: 'B', titleFa: 'ج', bodyFa: 'د' }];
    await runOnce(baseDeps(fakePrisma({ recentPosts })));

    const call = generateUniquePost.mock.calls[0]!;
    expect(call[3]).toEqual(['A\nB\nج\nد']);
  });

  it('saves the generated visual, records it on the post, and passes the local path through to publishPost', async () => {
    generateVisual.mockResolvedValue({
      buffer: Buffer.from('png-bytes'),
      visualType: 'TEMPLATE_STAT',
      imageContentHash: 'stat-hash-1',
    });
    const prisma = fakePrisma();

    await runOnce(baseDeps(prisma));

    expect(saveGeneratedImage).toHaveBeenCalledWith(Buffer.from('png-bytes'), 'trading_tips');
    expect(prisma.marketingPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          visualType: 'TEMPLATE_STAT',
          imagePath: '/path/to/generated-images/trading_tips-123-abcd.png',
          imageContentHash: 'stat-hash-1',
        }),
      }),
    );
    const publishArgs = publishPost.mock.calls[0]!;
    expect((publishArgs[2] as { imagePath?: string }).imagePath).toBe(
      '/path/to/generated-images/trading_tips-123-abcd.png',
    );
  });

  it('publishes text-only (visualType NONE) when generateVisual returns undefined', async () => {
    const prisma = fakePrisma();
    await runOnce(baseDeps(prisma));

    expect(saveGeneratedImage).not.toHaveBeenCalled();
    expect(prisma.marketingPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          visualType: 'NONE',
          imagePath: undefined,
          imageContentHash: undefined,
        }),
      }),
    );
  });

  it('drops a generated visual that duplicates a recently published one, publishing text-only instead', async () => {
    generateVisual.mockResolvedValue({
      buffer: Buffer.from('png-bytes'),
      visualType: 'TEMPLATE_STAT',
      imageContentHash: 'already-seen-hash',
    });
    const prisma = fakePrisma({ recentImages: [{ imageContentHash: 'already-seen-hash' }] });

    await runOnce(baseDeps(prisma));

    expect(saveGeneratedImage).not.toHaveBeenCalled();
    expect(prisma.marketingPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ visualType: 'NONE', imagePath: undefined }),
      }),
    );
  });

  it('selects hashtags from the generated post and passes them through to publishPost', async () => {
    await runOnce(baseDeps());

    expect(selectHashtags).toHaveBeenCalledWith({
      category: 'trading_tips',
      titleEn: GENERATED.titleEn,
      bodyEn: GENERATED.bodyEn,
    });
    const publishArgs = publishPost.mock.calls[0]!;
    expect((publishArgs[2] as { hashtags?: string[] }).hashtags).toEqual([
      '#Solana',
      '#Crypto',
      '#NovaSolanaAI',
    ]);
  });

  it('passes aiImageEnabled and the resolved image provider through to generateVisual', async () => {
    const fakeImageProvider = { name: 'gemini-image', generateImage: vi.fn() } as never;
    await runOnce({ ...baseDeps(), aiImageEnabled: true, imageProvider: fakeImageProvider });

    expect(generateVisual).toHaveBeenCalledWith(
      expect.objectContaining({ aiImageEnabled: true, imageProvider: fakeImageProvider }),
    );
  });
});
