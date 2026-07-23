import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { renderStatCard } from './statCard.js';
import { CANVAS_SIZE } from './theme.js';

describe('renderStatCard', () => {
  it('renders a square, Telegram-friendly PNG at the canonical canvas size', async () => {
    const buffer = await renderStatCard({
      bigNumber: '79',
      label: 'NEW TOKENS SCREENED',
      sublabel: '24H · SOLANA MEMECOIN PULSE',
    });

    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(CANVAS_SIZE);
    expect(metadata.height).toBe(CANVAS_SIZE);
  });

  it('never throws on a negative-sign or percent-formatted number', async () => {
    await expect(
      renderStatCard({
        bigNumber: '-3.5%',
        label: 'SOL 24H PRICE CHANGE',
        sublabel: 'SOLANA MARKET PULSE',
      }),
    ).resolves.toBeInstanceOf(Buffer);
  });
});
