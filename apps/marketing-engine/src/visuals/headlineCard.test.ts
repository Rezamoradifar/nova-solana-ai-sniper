import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { renderHeadlineCard } from './headlineCard.js';
import { CANVAS_SIZE, THEME } from './theme.js';

describe('renderHeadlineCard', () => {
  it('renders a square, Telegram-friendly PNG at the canonical canvas size', async () => {
    const buffer = await renderHeadlineCard({
      headline: 'A short brand headline',
      tag: 'ANNOUNCEMENT',
    });

    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(CANVAS_SIZE);
    expect(metadata.height).toBe(CANVAS_SIZE);
  });

  it('handles a long headline without throwing (auto-fit must never overflow the canvas)', async () => {
    const longHeadline =
      'Never trade a token you cannot sell — always verify a real sell route exists before you commit any capital to a fresh launch.';
    await expect(
      renderHeadlineCard({
        headline: longHeadline,
        tag: 'SECURITY ALERT',
        tagColor: THEME.warning,
      }),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it('accepts a pre-rendered custom background (the AI_GENERATED path) instead of generating its own', async () => {
    const customBg = await sharp({
      create: {
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
        channels: 4,
        background: { r: 20, g: 20, b: 20, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const buffer = await renderHeadlineCard(
      { headline: 'AI-backed visual', tag: 'ANNOUNCEMENT' },
      customBg,
    );
    const metadata = await sharp(buffer).metadata();
    expect(metadata.width).toBe(CANVAS_SIZE);
    expect(metadata.height).toBe(CANVAS_SIZE);
  });
});
