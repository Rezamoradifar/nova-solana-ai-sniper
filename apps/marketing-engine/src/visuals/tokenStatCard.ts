import sharp from 'sharp';
import { renderBackground } from './background.js';
import { renderChromeLayers } from './chrome.js';
import { renderTextLayer } from './textLayer.js';
import { CANVAS_SIZE, FONTS, THEME } from './theme.js';

/**
 * Stat-grid card for the ecosystemFeed's arbitrary-token categories
 * (Trending Tokens, Smart Money Trades, High Volume Tokens, Hidden Gems) —
 * tokens the bot has no owned position in, unlike tradeShowcase's cards
 * (which reuse @nova/telegram-bot's resolveTradePhoto/GeckoTerminal chart
 * instead, since those DO have a real entry/exit to chart).
 *
 * Every field is a pre-formatted string/number the caller already fetched
 * from a real source (DexScreener enrichment, the standalone rule-based risk
 * scorer) — same "never invents a figure" contract as StatCardBrief. No
 * embedded price chart in this version (fast-follow, separate scope — see
 * project plan).
 */
export interface TokenStatCardBrief {
  tokenName: string;
  tokenSymbol: string;
  /** Signed, drives the color (THEME.signal for >=0, THEME.warning for <0). */
  changePercent: number;
  /** Pre-formatted, e.g. "+42.5%" or "-18.2%". */
  changeLabel: string;
  categoryTag: string;
  status: 'LIVE' | 'CLOSED';
  marketCapLabel: string;
  liquidityLabel: string;
  volumeLabel: string;
  riskScoreLabel: string;
}

interface GridCell {
  label: string;
  value: string;
  left: number;
  top: number;
}

async function renderGridCell(
  cell: GridCell,
): Promise<{ label: Buffer; value: Buffer; left: number; top: number }> {
  const [label, value] = await Promise.all([
    renderTextLayer({
      text: cell.label,
      color: THEME.inkMuted,
      fontFile: FONTS.monoMedium,
      width: 460,
      height: 30,
      align: 'left',
      letterSpacing: 300,
    }),
    renderTextLayer({
      text: cell.value,
      color: THEME.ink,
      fontFile: FONTS.monoSemiBold,
      width: 460,
      height: 48,
      align: 'left',
    }),
  ]);
  return { label, value, left: cell.left, top: cell.top };
}

export async function renderTokenStatCard(brief: TokenStatCardBrief): Promise<Buffer> {
  const isUp = brief.changePercent >= 0;
  const changeColor = isUp ? THEME.signal : THEME.warning;
  const statusText = brief.status === 'LIVE' ? '🟢 LIVE' : '⚪ CLOSED';

  const grid: GridCell[] = [
    { label: 'MARKET CAP', value: brief.marketCapLabel, left: 64, top: 700 },
    { label: 'LIQUIDITY', value: brief.liquidityLabel, left: 580, top: 700 },
    { label: 'VOLUME (24H)', value: brief.volumeLabel, left: 64, top: 808 },
    { label: 'RISK SCORE', value: brief.riskScoreLabel, left: 580, top: 808 },
  ];

  const [bg, chrome, tag, status, name, change, cells] = await Promise.all([
    renderBackground(changeColor),
    renderChromeLayers(),
    renderTextLayer({
      text: brief.categoryTag,
      color: THEME.accent,
      fontFile: FONTS.monoSemiBold,
      width: 700,
      height: 34,
      align: 'left',
      letterSpacing: 1800,
    }),
    renderTextLayer({
      text: statusText,
      color: THEME.ink,
      fontFile: FONTS.monoSemiBold,
      width: 260,
      height: 34,
      align: 'right',
    }),
    renderTextLayer({
      text: `${brief.tokenName} (${brief.tokenSymbol})`,
      color: THEME.ink,
      fontFile: FONTS.displayBlack,
      width: 950,
      height: 130,
      align: 'left',
    }),
    renderTextLayer({
      text: brief.changeLabel,
      color: changeColor,
      fontFile: FONTS.monoBold,
      width: 950,
      height: 260,
      align: 'left',
    }),
    Promise.all(grid.map(renderGridCell)),
  ]);

  return sharp(bg)
    .composite([
      { input: chrome.brand, top: 64, left: 64 },
      { input: status, top: 60, left: CANVAS_SIZE - 64 - 260 },
      { input: tag, top: 140, left: 64 },
      { input: name, top: 188, left: 60 },
      { input: change, top: 350, left: 56 },
      ...cells.flatMap((cell) => [
        { input: cell.label, top: cell.top, left: cell.left },
        { input: cell.value, top: cell.top + 32, left: cell.left },
      ]),
      { input: chrome.handle, top: CANVAS_SIZE - 76, left: 64 },
    ])
    .png()
    .toBuffer();
}
