import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ImageProvider } from '@nova/ai';
import type { Logger, MarketingCategory } from '@nova/shared';
import type { MarketContext } from '../marketContext.js';
import { CATEGORY_TAG, decideVisualType } from './imagePolicy.js';
import { renderHeadlineCard } from './headlineCard.js';
import { renderStatCard, type StatCardBrief } from './statCard.js';
import { CANVAS_SIZE, THEME } from './theme.js';

export interface VisualResult {
  buffer: Buffer;
  visualType: 'TEMPLATE_STAT' | 'TEMPLATE_HEADLINE' | 'AI_GENERATED';
  imageContentHash: string;
}

export interface GenerateVisualInput {
  category: MarketingCategory;
  titleEn: string;
  marketContext: MarketContext;
  aiImageEnabled: boolean;
  imageProvider?: ImageProvider;
  logger: Logger;
  random?: () => number;
  /** Overrides the default category→tag mapping (CATEGORY_TAG) for a
   * TEMPLATE_HEADLINE/AI_GENERATED card — e.g. "SECURITY ALERT" with
   * THEME.warning for honeypot-education content. Not consulted by the
   * automated scheduler today (see runner.ts, imagePolicy.ts's own doc
   * comment on why there's no automatic sub-topic detection); available for
   * a caller (like scripts/dryRunVisualPosts.ts) that already knows a post's
   * specific angle. */
  tagOverride?: string;
  tagColorOverride?: string;
}

function hashVisual(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|').toLowerCase()).digest('hex');
}

function formatSolChange(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/** Builds the stat card's content strictly from real, already-fetched
 * figures — never invents a number. Which figure leads is chosen by topic
 * relevance, not just "whichever exists": a market_updates post is about
 * price action, so it leads with SOL's move; news/trending_tokens are about
 * discovery, so they lead with the screening count. Either figure falls
 * back to the other if its preferred one wasn't available. */
function buildStatBrief(
  category: MarketingCategory,
  ctx: MarketContext,
): StatCardBrief | undefined {
  const preferSolFirst = category === 'market_updates';

  if (preferSolFirst && ctx.solPriceChangePct24h !== undefined) {
    return {
      bigNumber: formatSolChange(ctx.solPriceChangePct24h),
      label: 'SOL 24H PRICE CHANGE',
      sublabel: 'SOLANA MARKET PULSE',
    };
  }

  if (ctx.tokensScreened24h !== undefined) {
    const solLine =
      ctx.solPriceChangePct24h !== undefined
        ? ` · SOL ${formatSolChange(ctx.solPriceChangePct24h)}`
        : '';
    return {
      bigNumber: String(ctx.tokensScreened24h),
      label: 'NEW TOKENS SCREENED',
      sublabel: `24H · SOLANA MEMECOIN PULSE${solLine}`,
    };
  }

  if (ctx.solPriceChangePct24h !== undefined) {
    return {
      bigNumber: formatSolChange(ctx.solPriceChangePct24h),
      label: 'SOL 24H PRICE CHANGE',
      sublabel: 'SOLANA MARKET PULSE',
    };
  }

  return undefined;
}

function truncateHeadline(title: string, max = 90): string {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
}

function buildAiImagePrompt(category: MarketingCategory, titleEn: string): string {
  return (
    'Abstract premium futuristic Web3/AI crypto-trading brand background. ' +
    'Dark near-black (#0B0C13) base, glowing violet (#8C6FFF) and mint-green (#35E8B0) light accents, ' +
    'subtle Solana-blockchain-inspired geometric network/particle motifs, high-end fintech atmosphere. ' +
    `Mood/theme: ${category.replace('_', ' ')} — ${titleEn}. ` +
    'No readable text, no logos, no watermarks, no people. Square 1:1 composition.'
  );
}

/**
 * Generates the visual for one post, or returns undefined for a text-only
 * post — see imagePolicy.ts for the decision itself. AI_GENERATED never
 * lets the model render our own text: an image model is unreliable at
 * producing crisp, correctly-spelled, on-brand typography, so a successful
 * AI call only supplies the *background* pixels for the exact same
 * headline-card text compositing TEMPLATE_HEADLINE uses (see
 * headlineCard.ts's own doc comment) — brand wordmark, tag, and headline are
 * always this codebase's own rendering, never the model's. Any AI failure
 * (including the currently-expected "no billing configured" case) falls
 * back to the plain template with no visible difference to a reader.
 */
export async function generateVisual(
  input: GenerateVisualInput,
): Promise<VisualResult | undefined> {
  const hasStatData =
    input.marketContext.tokensScreened24h !== undefined ||
    input.marketContext.solPriceChangePct24h !== undefined;
  const decision = decideVisualType(
    { category: input.category, hasStatData, aiImageEnabled: input.aiImageEnabled },
    input.random,
  );

  if (decision.type === 'NONE') return undefined;

  if (decision.type === 'TEMPLATE_STAT') {
    const brief = buildStatBrief(input.category, input.marketContext);
    if (!brief) return undefined; // defensive: hasStatData already guarantees this, but never fabricate
    const buffer = await renderStatCard(brief);
    return {
      buffer,
      visualType: 'TEMPLATE_STAT',
      imageContentHash: hashVisual('STAT', brief.bigNumber, brief.label, brief.sublabel),
    };
  }

  const tag = input.tagOverride ?? CATEGORY_TAG[input.category];
  const tagColor = input.tagColorOverride ?? THEME.accent;
  const headline = truncateHeadline(input.titleEn);

  if (decision.attemptAiFirst && input.imageProvider) {
    try {
      const raw = await input.imageProvider.generateImage(
        buildAiImagePrompt(input.category, input.titleEn),
      );
      const background = await sharp(raw)
        .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: 'cover' })
        .png()
        .toBuffer();
      const buffer = await renderHeadlineCard({ headline, tag, tagColor }, background);
      return {
        buffer,
        visualType: 'AI_GENERATED',
        imageContentHash: hashVisual('AI', input.category, input.titleEn),
      };
    } catch (err) {
      input.logger.warn(
        { err, category: input.category },
        'AI image generation failed — falling back to the branded template visual',
      );
    }
  }

  const buffer = await renderHeadlineCard({ headline, tag, tagColor });
  return {
    buffer,
    visualType: 'TEMPLATE_HEADLINE',
    imageContentHash: hashVisual('HEADLINE', tag, headline),
  };
}
