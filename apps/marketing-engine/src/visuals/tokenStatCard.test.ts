import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { renderTokenStatCard, type TokenStatCardBrief } from './tokenStatCard.js';
import { CANVAS_SIZE } from './theme.js';

function brief(overrides: Partial<TokenStatCardBrief> = {}): TokenStatCardBrief {
  return {
    tokenName: 'GigaChad',
    tokenSymbol: 'GIGA',
    changePercent: 42.5,
    changeLabel: '+42.5%',
    categoryTag: 'TRENDING TOKEN',
    status: 'LIVE',
    marketCapLabel: '$1.2M',
    liquidityLabel: '$85K',
    volumeLabel: '$420K',
    riskScoreLabel: '78/100',
    ...overrides,
  };
}

describe('renderTokenStatCard', () => {
  it('renders a square, Telegram-friendly PNG at the canonical canvas size', async () => {
    const buffer = await renderTokenStatCard(brief());

    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(CANVAS_SIZE);
    expect(metadata.height).toBe(CANVAS_SIZE);
  });

  it('never throws for a negative-change (down) token', async () => {
    await expect(
      renderTokenStatCard(brief({ changePercent: -18.2, changeLabel: '-18.2%', status: 'CLOSED' })),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it('never throws on an unusually long token name', async () => {
    await expect(
      renderTokenStatCard(
        brief({ tokenName: 'A Very Long Memecoin Name That Keeps Going And Going' }),
      ),
    ).resolves.toBeInstanceOf(Buffer);
  });
});
