import { MarketingCategory as PrismaMarketingCategory, type PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { Logger, MarketingCategory } from '@nova/shared';
import type { AiProvider, ImageProvider } from '@nova/ai';
import type { Bot } from '@nova/telegram-bot';
import { publishPost } from '@nova/telegram-bot';
import { pickNextCategory } from './categories.js';
import { planDailyPostTimes, remainingPostTimes } from './scheduler.js';
import { generateUniquePost } from './generator.js';
import { buildButtons, type ButtonContext } from './buttons.js';
import { selectHashtags } from './hashtags.js';
import { fetchMarketContext, formatMarketFacts, type MarketContext } from './marketContext.js';
import { generateVisual } from './visuals/render.js';
import { saveGeneratedImage } from './visuals/imageStore.js';
import { STAT_ELIGIBLE_CATEGORIES } from './visuals/imagePolicy.js';

/** How many of the most recent published posts to compare new content
 * against for near-duplicate detection (see dedupe.ts) — enough to catch a
 * reworded repeat within the last ~1-2 weeks at 3-5 posts/day, without an
 * unbounded query. */
const RECENT_POSTS_FOR_DEDUPE = 40;

/** Same window used for image-content dedupe (see imageContentHash's own
 * schema doc comment) — an identical stat card is far more likely to recur
 * naturally than identical post text, so this is checked every time a
 * visual is generated, not just for stat cards. */
const RECENT_IMAGES_FOR_DEDUPE = 40;

const CATEGORY_TO_ENUM: Record<MarketingCategory, PrismaMarketingCategory> = {
  news: PrismaMarketingCategory.NEWS,
  trading_tips: PrismaMarketingCategory.TRADING_TIPS,
  market_updates: PrismaMarketingCategory.MARKET_UPDATES,
  trending_tokens: PrismaMarketingCategory.TRENDING_TOKENS,
  referral: PrismaMarketingCategory.REFERRAL,
  announcements: PrismaMarketingCategory.ANNOUNCEMENTS,
};

const ENUM_TO_CATEGORY: Record<PrismaMarketingCategory, MarketingCategory> = {
  NEWS: 'news',
  TRADING_TIPS: 'trading_tips',
  MARKET_UPDATES: 'market_updates',
  TRENDING_TOKENS: 'trending_tokens',
  REFERRAL: 'referral',
  ANNOUNCEMENTS: 'announcements',
};

export interface RunnerDeps {
  prisma: PrismaClient;
  provider: AiProvider;
  bot: Bot;
  chatId: string;
  buttonContext: ButtonContext;
  logger: Logger;
  /** Master switch for attempting an AI-generated visual background — see
   * MARKETING_AI_IMAGE_ENABLED's own env.ts doc comment. */
  aiImageEnabled: boolean;
  /** Resolved iff GEMINI_API_KEY is configured — a resolved provider is not
   * a guarantee of success (see visuals/render.ts's own doc comment on the
   * AI_GENERATED fallback). */
  imageProvider?: ImageProvider;
}

/** Fetches the last N published categories (most recent first) to feed the no-repeat rule. */
async function getRecentCategories(prisma: PrismaClient, limit = 1): Promise<MarketingCategory[]> {
  const recent = await prisma.marketingPost.findMany({
    where: { publishedAt: { not: null } },
    orderBy: { publishedAt: 'desc' },
    take: limit,
    select: { category: true },
  });
  return recent.map((r) => ENUM_TO_CATEGORY[r.category]);
}

/** Fetches recent published posts' full bilingual text for the near-duplicate
 * similarity check (see dedupe.ts) — across all categories, since a reworded
 * repeat is just as repetitive to a subscriber regardless of which category
 * either post was tagged with. */
async function getRecentPostTexts(prisma: PrismaClient, limit: number): Promise<string[]> {
  const recent = await prisma.marketingPost.findMany({
    where: { publishedAt: { not: null } },
    orderBy: { publishedAt: 'desc' },
    take: limit,
    select: { titleEn: true, bodyEn: true, titleFa: true, bodyFa: true },
  });
  return recent.map((r) => `${r.titleEn}\n${r.bodyEn}\n${r.titleFa}\n${r.bodyFa}`);
}

/** Recent posts' imageContentHash values (excluding NONE-visual posts, which
 * have none) — used to reject an exact-duplicate generated visual before it
 * ever gets attached to a post (see imageContentHash's own schema doc
 * comment). */
async function getRecentImageHashes(prisma: PrismaClient, limit: number): Promise<Set<string>> {
  const recent = await prisma.marketingPost.findMany({
    where: { imageContentHash: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { imageContentHash: true },
  });
  return new Set(recent.map((r) => r.imageContentHash!));
}

export interface RunOnceResult {
  postId: string;
  category: MarketingCategory;
  messageId: number;
}

/** Generates and publishes exactly one post. Returns undefined when the slot
 * was skipped (no unique content found after max attempts) — never throws
 * for that case, only for a genuine I/O failure (DB, AI provider, Telegram
 * send), which callers are expected to catch (see startDailyScheduler and
 * scripts/sendTestPost.ts). */
export async function runOnce(deps: RunnerDeps): Promise<RunOnceResult | undefined> {
  const recentCategories = await getRecentCategories(deps.prisma);
  const category = pickNextCategory(recentCategories);

  const [recentPostTexts, marketContext] = await Promise.all([
    getRecentPostTexts(deps.prisma, RECENT_POSTS_FOR_DEDUPE),
    STAT_ELIGIBLE_CATEGORIES.includes(category)
      ? fetchMarketContext(deps.prisma, deps.logger)
      : Promise.resolve<MarketContext>({}),
  ]);

  const generated = await generateUniquePost(
    deps.provider,
    category,
    async (contentHash) => {
      const existing = await deps.prisma.marketingPost.findUnique({ where: { contentHash } });
      return existing !== null;
    },
    recentPostTexts,
    deps.logger,
    formatMarketFacts(marketContext),
  );

  if (!generated) {
    deps.logger.warn({ category }, 'skipping scheduled post — could not generate unique content');
    return;
  }

  const buttons = buildButtons(category, deps.buttonContext);
  const hashtags = selectHashtags({
    category,
    titleEn: generated.titleEn,
    bodyEn: generated.bodyEn,
  });

  const visual = await generateVisual({
    category,
    titleEn: generated.titleEn,
    marketContext,
    aiImageEnabled: deps.aiImageEnabled,
    imageProvider: deps.imageProvider,
    logger: deps.logger,
  });

  let imagePath: string | undefined;
  let visualType: 'NONE' | 'TEMPLATE_STAT' | 'TEMPLATE_HEADLINE' | 'AI_GENERATED' = 'NONE';
  let imageContentHash: string | undefined;

  if (visual) {
    const recentImageHashes = await getRecentImageHashes(deps.prisma, RECENT_IMAGES_FOR_DEDUPE);
    if (recentImageHashes.has(visual.imageContentHash)) {
      deps.logger.info(
        { category, visualType: visual.visualType },
        'generated visual was a duplicate of a recently published one — publishing text-only instead',
      );
    } else {
      imagePath = await saveGeneratedImage(visual.buffer, category);
      visualType = visual.visualType;
      imageContentHash = visual.imageContentHash;
    }
  }

  const post = await deps.prisma.marketingPost.create({
    data: {
      category: CATEGORY_TO_ENUM[category],
      contentHash: generated.contentHash,
      titleEn: generated.titleEn,
      bodyEn: generated.bodyEn,
      titleFa: generated.titleFa,
      bodyFa: generated.bodyFa,
      visualType,
      imagePath,
      imageContentHash,
      buttons: buttons as unknown as Prisma.InputJsonValue,
      scheduledFor: new Date(),
    },
  });

  const { messageId } = await publishPost(
    deps.bot,
    deps.chatId,
    { ...post, buttons, hashtags },
    deps.logger,
  );

  await deps.prisma.marketingPost.update({
    where: { id: post.id },
    data: { publishedAt: new Date(), telegramMessageId: messageId },
  });

  deps.logger.info(
    { postId: post.id, category, messageId, visualType },
    'marketing post published',
  );
  return { postId: post.id, category, messageId };
}

/**
 * Runs forever: at each local midnight (and immediately on startup for
 * whatever's left of today), plans 3-5 random post times and schedules a
 * `runOnce` call for each one. Returns a stop function for graceful shutdown.
 */
export function startDailyScheduler(deps: RunnerDeps): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;

  function scheduleDay(dayStart: Date) {
    const planned = planDailyPostTimes(dayStart);
    const upcoming = remainingPostTimes(planned, new Date());

    deps.logger.info(
      { count: upcoming.length, times: upcoming.map((t) => t.toISOString()) },
      'planned marketing posts for today',
    );

    for (const time of upcoming) {
      const delay = time.getTime() - Date.now();
      const timer = setTimeout(() => {
        runOnce(deps).catch((err) => deps.logger.error({ err }, 'scheduled post run failed'));
      }, delay);
      timers.push(timer);
    }

    const nextMidnight = new Date(dayStart);
    nextMidnight.setDate(nextMidnight.getDate() + 1);
    const msUntilMidnight = nextMidnight.getTime() - Date.now();
    const midnightTimer = setTimeout(() => {
      if (!stopped) scheduleDay(nextMidnight);
    }, msUntilMidnight);
    timers.push(midnightTimer);
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  scheduleDay(todayStart);

  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
  };
}
