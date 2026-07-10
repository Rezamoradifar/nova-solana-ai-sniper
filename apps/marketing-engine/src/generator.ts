import type { AiProvider } from '@nova/ai';
import type { MarketingCategory } from '@nova/shared';
import type { Logger } from '@nova/shared';
import { buildPrompt, SYSTEM_PROMPT } from './prompts.js';
import { hashContent } from './contentHash.js';

export interface GeneratedPost {
  category: MarketingCategory;
  title: string;
  body: string;
  contentHash: string;
}

interface RawPost {
  title: string;
  body: string;
}

function parsePostResponse(raw: string): RawPost | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<RawPost>;
    if (typeof parsed.title === 'string' && typeof parsed.body === 'string') {
      return { title: parsed.title, body: parsed.body };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const MAX_ATTEMPTS = 4;

/**
 * Generates a post for `category`, regenerating (with an explicit "be
 * different" nudge) up to MAX_ATTEMPTS times whenever `isDuplicate` reports a
 * hash collision against already-published content. Returns undefined if it
 * can't find a unique post after all attempts — callers should skip that
 * scheduled slot rather than publish a repeat.
 */
export async function generateUniquePost(
  provider: AiProvider,
  category: MarketingCategory,
  isDuplicate: (contentHash: string) => Promise<boolean>,
  logger: Logger,
): Promise<GeneratedPost | undefined> {
  let avoidHint: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await provider.generateText(buildPrompt(category, avoidHint), {
      system: SYSTEM_PROMPT,
      maxTokens: 400,
      temperature: 0.9,
    });

    const parsed = parsePostResponse(raw);
    if (!parsed) {
      logger.warn({ category, attempt }, 'marketing post response was not valid JSON, retrying');
      avoidHint = 'respond with strictly valid JSON only';
      continue;
    }

    const contentHash = hashContent(parsed.title, parsed.body);
    if (await isDuplicate(contentHash)) {
      logger.info({ category, attempt }, 'generated post was a duplicate, regenerating');
      avoidHint = `avoid repeating: "${parsed.title}"`;
      continue;
    }

    return { category, title: parsed.title, body: parsed.body, contentHash };
  }

  logger.error({ category }, 'failed to generate a unique post after max attempts');
  return undefined;
}
