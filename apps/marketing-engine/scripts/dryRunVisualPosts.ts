/**
 * Generates 3 sample bilingual + visual posts WITHOUT publishing to Telegram
 * and WITHOUT starting the recurring scheduler — for reviewing the visual
 * pipeline's real output (real AI copy generation, real fetched market
 * data, real rendered images) before enabling automatic visual publishing.
 *
 * Writes each image to apps/marketing-engine/generated-images/dry-run/ and
 * prints a JSON summary (captions + image paths) to stdout.
 *
 * Usage: npm run dry-run-visuals -w apps/marketing-engine
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createLogger } from '@nova/shared';
import {
  resolveGeminiImageProvider,
  resolveGeminiProvider,
  resolveOpenRouterProvider,
  resolvePrimaryFallbackProvider,
} from '@nova/ai';
import { loadMarketingEnv } from '../src/config/env.js';
import { generateUniquePost } from '../src/generator.js';
import { fetchMarketContext, formatMarketFacts } from '../src/marketContext.js';
import { generateVisual } from '../src/visuals/render.js';
import { GENERATED_IMAGES_DIR } from '../src/visuals/imageStore.js';
import { THEME } from '../src/visuals/theme.js';

const logger = createLogger('marketing-engine:dry-run-visuals');
const DRY_RUN_DIR = path.join(GENERATED_IMAGES_DIR, 'dry-run');

interface Sample {
  label: string;
  category: 'market_updates' | 'trending_tokens' | 'trading_tips';
  topicHint?: string;
  tagOverride?: string;
  tagColorOverride?: string;
}

const SAMPLES: Sample[] = [
  { label: 'Market update', category: 'market_updates' },
  { label: 'Token screening statistics', category: 'trending_tokens' },
  {
    label: 'Security / honeypot warning',
    category: 'trading_tips',
    topicHint:
      'Specifically about honeypot tokens: how a trader can end up able to buy but never sell, and how to recognize the warning signs before buying — a security-education post, not a generic tip.',
    tagOverride: 'SECURITY ALERT',
    tagColorOverride: THEME.warning,
  },
];

async function main() {
  const env = loadMarketingEnv();

  const provider = resolvePrimaryFallbackProvider(
    resolveGeminiProvider({ geminiApiKey: env.GEMINI_API_KEY }),
    resolveOpenRouterProvider({
      openrouterApiKey: env.OPENROUTER_API_KEY,
      openrouterModel: env.OPENROUTER_MODEL,
    }),
  );
  if (!provider) throw new Error('GEMINI_API_KEY or OPENROUTER_API_KEY must be set.');

  const imageProvider = resolveGeminiImageProvider({ geminiApiKey: env.GEMINI_API_KEY });
  const prisma = new PrismaClient();
  await fs.mkdir(DRY_RUN_DIR, { recursive: true });

  const results = [];

  for (const sample of SAMPLES) {
    logger.info({ label: sample.label, category: sample.category }, 'generating dry-run sample');

    const marketContext =
      sample.category === 'market_updates' || sample.category === 'trending_tokens'
        ? await fetchMarketContext(prisma, logger)
        : {};

    const generated = await generateUniquePost(
      provider,
      sample.category,
      async () => false, // dry run: never treat anything as an exact duplicate
      [], // dry run: no near-duplicate comparison against real history
      logger,
      formatMarketFacts(marketContext),
      sample.topicHint,
    );

    if (!generated) {
      results.push({ label: sample.label, ok: false, error: 'content generation failed' });
      continue;
    }

    const visual = await generateVisual({
      category: sample.category,
      titleEn: generated.titleEn,
      marketContext,
      aiImageEnabled: env.MARKETING_AI_IMAGE_ENABLED,
      imageProvider,
      logger,
      tagOverride: sample.tagOverride,
      tagColorOverride: sample.tagColorOverride,
      random: () => 0, // dry run: always attach a visual so there's something to review
    });

    let imagePath: string | undefined;
    if (visual) {
      imagePath = path.join(DRY_RUN_DIR, `${sample.category}-${Date.now()}.png`);
      await fs.writeFile(imagePath, visual.buffer);
    }

    results.push({
      label: sample.label,
      ok: true,
      category: sample.category,
      visualType: visual?.visualType ?? 'NONE',
      imagePath,
      titleEn: generated.titleEn,
      bodyEn: generated.bodyEn,
      titleFa: generated.titleFa,
      bodyFa: generated.bodyFa,
    });
  }

  await prisma.$disconnect();
   
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((err) => {
  logger.error({ err }, 'dry-run-visuals failed');
   
  console.error(
    JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  process.exit(1);
});
