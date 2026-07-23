import { describe, expect, it, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import type { Logger } from '@nova/shared';
import type { ImageProvider } from '@nova/ai';

/** A real, decodable tiny PNG — render.ts pipes AI output through
 * sharp(...).resize(...), so a fake buffer that's merely magic-byte-shaped
 * (not a real image) would throw during resize and silently exercise the
 * fallback path instead of the success path this test means to cover. */
async function tinyValidPng(): Promise<Buffer> {
  return sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

const renderStatCard = vi.fn();
const renderHeadlineCard = vi.fn();

vi.mock('./statCard.js', () => ({ renderStatCard }));
vi.mock('./headlineCard.js', () => ({ renderHeadlineCard }));

const { generateVisual } = await import('./render.js');

const fakeLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  vi.clearAllMocks();
  renderStatCard.mockResolvedValue(Buffer.from('stat-png'));
  renderHeadlineCard.mockResolvedValue(Buffer.from('headline-png'));
});

describe('generateVisual', () => {
  it('returns undefined (text-only) when the policy decides NONE', async () => {
    const result = await generateVisual({
      category: 'referral',
      titleEn: 'Invite friends',
      marketContext: {},
      aiImageEnabled: false,
      logger: fakeLogger,
      random: () => 0.999, // above HEADLINE_VISUAL_PROBABILITY -> NONE
    });
    expect(result).toBeUndefined();
    expect(renderStatCard).not.toHaveBeenCalled();
    expect(renderHeadlineCard).not.toHaveBeenCalled();
  });

  it('a market_updates stat card leads with the SOL price move (topic-relevant), not the token count', async () => {
    const result = await generateVisual({
      category: 'market_updates',
      titleEn: 'Solana pulse',
      marketContext: { tokensScreened24h: 79, solPriceChangePct24h: 4.2 },
      aiImageEnabled: false,
      logger: fakeLogger,
    });

    expect(result?.visualType).toBe('TEMPLATE_STAT');
    expect(renderStatCard).toHaveBeenCalledWith(
      expect.objectContaining({ bigNumber: '+4.2%', label: 'SOL 24H PRICE CHANGE' }),
    );
    expect(result?.imageContentHash).toBeTruthy();
  });

  it('a trending_tokens stat card leads with the platform screening count (topic-relevant), not SOL price', async () => {
    const result = await generateVisual({
      category: 'trending_tokens',
      titleEn: 'New launches worth watching',
      marketContext: { tokensScreened24h: 79, solPriceChangePct24h: 4.2 },
      aiImageEnabled: false,
      logger: fakeLogger,
    });

    expect(renderStatCard).toHaveBeenCalledWith(
      expect.objectContaining({ bigNumber: '79', label: 'NEW TOKENS SCREENED' }),
    );
  });

  it('falls back to whichever figure is actually available when the preferred one is missing', async () => {
    const result = await generateVisual({
      category: 'market_updates',
      titleEn: 'Solana pulse',
      marketContext: { tokensScreened24h: 79 },
      aiImageEnabled: false,
      logger: fakeLogger,
    });

    expect(result?.visualType).toBe('TEMPLATE_STAT');
    expect(renderStatCard).toHaveBeenCalledWith(expect.objectContaining({ bigNumber: '79' }));
  });

  it('never fabricates a number: falls through to headline logic when no market data is available', async () => {
    const result = await generateVisual({
      category: 'market_updates',
      titleEn: 'Solana pulse',
      marketContext: {},
      aiImageEnabled: false,
      logger: fakeLogger,
      random: () => 0, // below probability -> headline card
    });

    expect(renderStatCard).not.toHaveBeenCalled();
    expect(result?.visualType).toBe('TEMPLATE_HEADLINE');
  });

  it('uses the template headline card when AI images are disabled', async () => {
    const result = await generateVisual({
      category: 'announcements',
      titleEn: 'New feature ships today',
      marketContext: {},
      aiImageEnabled: false,
      logger: fakeLogger,
      random: () => 0, // below HEADLINE_VISUAL_PROBABILITY -> a visual is attached
    });

    expect(result?.visualType).toBe('TEMPLATE_HEADLINE');
    expect(renderHeadlineCard).toHaveBeenCalledTimes(1);
    // no custom background passed
    expect(renderHeadlineCard.mock.calls[0]![1]).toBeUndefined();
  });

  it('attempts AI generation first for an AI-eligible category and uses its output as the background on success', async () => {
    const generateImage = vi.fn().mockResolvedValue(await tinyValidPng());
    const provider: ImageProvider = { name: 'gemini-image', generateImage };

    const result = await generateVisual({
      category: 'announcements',
      titleEn: 'New feature ships today',
      marketContext: {},
      aiImageEnabled: true,
      imageProvider: provider,
      logger: fakeLogger,
    });

    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(result?.visualType).toBe('AI_GENERATED');
    expect(renderHeadlineCard).toHaveBeenCalledTimes(1);
    expect(renderHeadlineCard.mock.calls[0]![1]).toBeInstanceOf(Buffer);
  });

  it('falls back to the plain template when AI generation throws (e.g. quota exceeded)', async () => {
    const generateImage = vi.fn().mockRejectedValue(new Error('429 quota exceeded'));
    const provider: ImageProvider = { name: 'gemini-image', generateImage };

    const result = await generateVisual({
      category: 'announcements',
      titleEn: 'New feature ships today',
      marketContext: {},
      aiImageEnabled: true,
      imageProvider: provider,
      logger: fakeLogger,
    });

    expect(result?.visualType).toBe('TEMPLATE_HEADLINE');
    expect(renderHeadlineCard.mock.calls[0]![1]).toBeUndefined();
    expect(fakeLogger.warn).toHaveBeenCalled();
  });

  it('does not attempt AI generation when aiImageEnabled is true but no provider was resolved', async () => {
    const result = await generateVisual({
      category: 'announcements',
      titleEn: 'New feature ships today',
      marketContext: {},
      aiImageEnabled: true,
      imageProvider: undefined,
      logger: fakeLogger,
    });

    expect(result?.visualType).toBe('TEMPLATE_HEADLINE');
  });
});
