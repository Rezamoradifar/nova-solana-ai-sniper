import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { renderNetworkTradeCard, type NetworkTradeCardBrief } from './networkTradeCard.js';
import { CANVAS_SIZE } from './theme.js';

function brief(overrides: Partial<NetworkTradeCardBrief> = {}): NetworkTradeCardBrief {
  return {
    tokenName: 'GigaChad',
    tokenSymbol: 'GIGA',
    roiPercent: 80,
    roiLabel: '+80.0%',
    pnlLabel: '+$150.00 · +0.800 SOL',
    categoryTag: 'SMART MONEY',
    marketCapLabel: '$1.2M',
    liquidityLabel: '$42K',
    volumeLabel: '$88K',
    aiScoreLabel: '72/100',
    entryLabel: '$0.00100000',
    exitLabel: '$0.00180000',
    ...overrides,
  };
}

/** A tiny valid 1x1 red PNG — real bytes sharp can actually decode, standing
 * in for a fetched token logo without a network call in tests. */
async function tinyPngBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

describe('renderNetworkTradeCard', () => {
  it('renders a square, Telegram-friendly PNG at the canonical canvas size with no logo', async () => {
    const buffer = await renderNetworkTradeCard(brief());

    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(CANVAS_SIZE);
    expect(metadata.height).toBe(CANVAS_SIZE);
  });

  it('composites a real logo buffer without changing the canvas size', async () => {
    const logo = await tinyPngBuffer();
    const buffer = await renderNetworkTradeCard(brief(), logo);

    const metadata = await sharp(buffer).metadata();
    expect(metadata.width).toBe(CANVAS_SIZE);
    expect(metadata.height).toBe(CANVAS_SIZE);
  });

  it('never throws for a loss (negative ROI) trade', async () => {
    await expect(
      renderNetworkTradeCard(
        brief({ roiPercent: -40, roiLabel: '-40.0%', pnlLabel: '-$60.00 · -0.300 SOL' }),
      ),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it('degrades gracefully (still renders) when the logo buffer is undecodable garbage', async () => {
    const garbage = Buffer.from('not a real image');
    await expect(renderNetworkTradeCard(brief(), garbage)).resolves.toBeInstanceOf(Buffer);
  });

  it('never throws on an unusually long token name', async () => {
    await expect(
      renderNetworkTradeCard(
        brief({ tokenName: 'A Very Long Memecoin Name That Keeps Going And Going' }),
      ),
    ).resolves.toBeInstanceOf(Buffer);
  });
});
