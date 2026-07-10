import { MarketingCategory as PrismaMarketingCategory, type PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { Logger, MarketingCategory } from '@nova/shared';
import type { AiProvider } from '@nova/ai';
import type { Bot } from '@nova/telegram-bot';
import { publishPost } from '@nova/telegram-bot';
import { pickNextCategory } from './categories.js';
import { planDailyPostTimes, remainingPostTimes } from './scheduler.js';
import { generateUniquePost } from './generator.js';
import { buildButtons, type ButtonContext } from './buttons.js';

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

export async function runOnce(deps: RunnerDeps): Promise<void> {
  const recentCategories = await getRecentCategories(deps.prisma);
  const category = pickNextCategory(recentCategories);

  const generated = await generateUniquePost(
    deps.provider,
    category,
    async (contentHash) => {
      const existing = await deps.prisma.marketingPost.findUnique({ where: { contentHash } });
      return existing !== null;
    },
    deps.logger,
  );

  if (!generated) {
    deps.logger.warn({ category }, 'skipping scheduled post — could not generate unique content');
    return;
  }

  const buttons = buildButtons(category, deps.buttonContext);

  const post = await deps.prisma.marketingPost.create({
    data: {
      category: CATEGORY_TO_ENUM[category],
      contentHash: generated.contentHash,
      title: generated.title,
      body: generated.body,
      buttons: buttons as unknown as Prisma.InputJsonValue,
      scheduledFor: new Date(),
    },
  });

  await publishPost(deps.bot, deps.chatId, { ...post, buttons }, deps.logger);

  await deps.prisma.marketingPost.update({
    where: { id: post.id },
    data: { publishedAt: new Date() },
  });

  deps.logger.info({ postId: post.id, category }, 'marketing post published');
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
