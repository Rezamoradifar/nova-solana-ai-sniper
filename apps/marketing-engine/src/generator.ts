import type { AiProvider } from '@nova/ai';
import type { MarketingCategory } from '@nova/shared';
import type { Logger } from '@nova/shared';
import { buildPrompt, SYSTEM_PROMPT } from './prompts.js';
import { hashContent } from './contentHash.js';
import { isNearDuplicate } from './dedupe.js';

export interface GeneratedPost {
  category: MarketingCategory;
  titleEn: string;
  bodyEn: string;
  titleFa: string;
  bodyFa: string;
  contentHash: string;
}

interface RawPost {
  titleEn: string;
  bodyEn: string;
  titleFa: string;
  bodyFa: string;
}

function parsePostResponse(raw: string): RawPost | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<RawPost>;
    if (
      typeof parsed.titleEn === 'string' &&
      typeof parsed.bodyEn === 'string' &&
      typeof parsed.titleFa === 'string' &&
      typeof parsed.bodyFa === 'string'
    ) {
      return {
        titleEn: parsed.titleEn,
        bodyEn: parsed.bodyEn,
        titleFa: parsed.titleFa,
        bodyFa: parsed.bodyFa,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Renders a post as one plain-text blob for the near-duplicate similarity
 * check — same shape (both languages together) as what actually gets
 * published, so "near-duplicate" means near-duplicate of the real message. */
function renderForSimilarity(post: RawPost): string {
  return `${post.titleEn}\n${post.bodyEn}\n${post.titleFa}\n${post.bodyFa}`;
}

const MAX_ATTEMPTS = 4;

/**
 * Generates a bilingual post for `category`, regenerating (with an explicit
 * "be different" nudge) up to MAX_ATTEMPTS times whenever the content is an
 * exact hash duplicate OR a near-duplicate (see dedupe.ts) of already-
 * published content. Returns undefined if it can't find unique content after
 * all attempts — callers should skip that scheduled slot rather than publish
 * a repeat.
 */
export async function generateUniquePost(
  provider: AiProvider,
  category: MarketingCategory,
  isDuplicate: (contentHash: string) => Promise<boolean>,
  recentPostTexts: string[],
  logger: Logger,
  marketFacts?: string,
  topicHint?: string,
): Promise<GeneratedPost | undefined> {
  let avoidHint: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await provider.generateText(
      buildPrompt(category, { avoidHint, marketFacts, topicHint }),
      {
        system: SYSTEM_PROMPT,
        maxTokens: 700,
        temperature: 0.9,
      },
    );

    const parsed = parsePostResponse(raw);
    if (!parsed) {
      logger.warn({ category, attempt }, 'marketing post response was not valid JSON, retrying');
      avoidHint = 'respond with strictly valid JSON only, with all four required fields';
      continue;
    }

    const contentHash = hashContent(parsed.titleEn, parsed.bodyEn, parsed.titleFa, parsed.bodyFa);
    if (await isDuplicate(contentHash)) {
      logger.info({ category, attempt }, 'generated post was an exact duplicate, regenerating');
      avoidHint = `avoid repeating: "${parsed.titleEn}"`;
      continue;
    }

    if (isNearDuplicate(renderForSimilarity(parsed), recentPostTexts)) {
      logger.info(
        { category, attempt },
        'generated post was a near-duplicate of recent content, regenerating',
      );
      avoidHint = `write something meaningfully different in substance from recent posts, not just reworded — avoid the angle of: "${parsed.titleEn}"`;
      continue;
    }

    return { category, ...parsed, contentHash };
  }

  logger.error({ category }, 'failed to generate unique content after max attempts');
  return undefined;
}
