import sharp from 'sharp';
import { renderBackground } from './background.js';
import { renderChromeLayers } from './chrome.js';
import { renderTextLayer } from './textLayer.js';
import { CANVAS_SIZE, FONTS, THEME } from './theme.js';

/**
 * Network Trade Feed's "premium generated image" (2026-08-02 spec) — same
 * sharp/SVG-background/Pango-text compositing pipeline as tokenStatCard.ts
 * (this module's own grid-cell helper is a deliberate copy of that file's
 * renderGridCell, not a shared import — same per-template-file isolation
 * convention this visuals/ package already uses), extended with a
 * circle-masked token logo in the top-right corner (tokenStatCard's
 * LIVE/CLOSED status slot — a Network Trade post is always a completed
 * trade, so that slot is free here).
 *
 * Deliberately takes `logoBuffer` as an already-fetched, already-validated
 * Buffer rather than fetching a URL itself — every render function in this
 * package is pure with respect to I/O (see fetchNetworkTradeLogo.ts for the
 * bounded fetch this expects its caller to have done first). A missing or
 * unusable logo (undefined, or a buffer sharp can't decode) simply omits the
 * circle — never blocks the card, never fabricates a placeholder image.
 */
export interface NetworkTradeCardBrief {
  tokenName: string;
  tokenSymbol: string;
  /** Signed, drives the ROI number's color (THEME.signal for >=0, THEME.warning for <0). */
  roiPercent: number;
  /** Pre-formatted, e.g. "+80.0%" or "-40.0%". */
  roiLabel: string;
  /** Pre-formatted PnL summary, e.g. "+$150.00 · +0.800 SOL". */
  pnlLabel: string;
  /** "SMART MONEY" / "TRENDING TOKEN" / "NETWORK TRADE" — see data.ts's categorizeNetworkTrade. */
  categoryTag: string;
  marketCapLabel: string;
  liquidityLabel: string;
  volumeLabel: string;
  aiScoreLabel: string;
  entryLabel: string;
  exitLabel: string;
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
      height: 40,
      align: 'left',
    }),
  ]);
  return { label, value, left: cell.left, top: cell.top };
}

const LOGO_SIZE = 140;
const LOGO_TOP = 56;
const LOGO_LEFT = CANVAS_SIZE - 64 - LOGO_SIZE;

/** Resizes+circle-masks a raw fetched image buffer. Returns undefined (never
 * throws) if the buffer isn't a decodable image — the card renders without
 * the logo circle in that case, same "omit rather than invent" convention as
 * every other real-data-only path in this codebase. */
async function circleMaskLogo(logoBuffer: Buffer): Promise<Buffer | undefined> {
  try {
    const resized = await sharp(logoBuffer)
      .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'cover' })
      .png()
      .toBuffer();
    const mask = Buffer.from(
      `<svg width="${LOGO_SIZE}" height="${LOGO_SIZE}"><circle cx="${LOGO_SIZE / 2}" cy="${LOGO_SIZE / 2}" r="${LOGO_SIZE / 2}" fill="#fff"/></svg>`,
    );
    return await sharp(resized)
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer();
  } catch {
    return undefined;
  }
}

export async function renderNetworkTradeCard(
  brief: NetworkTradeCardBrief,
  logoBuffer?: Buffer,
): Promise<Buffer> {
  const isProfit = brief.roiPercent >= 0;
  const roiColor = isProfit ? THEME.signal : THEME.warning;

  const grid: GridCell[] = [
    { label: 'MARKET CAP', value: brief.marketCapLabel, left: 64, top: 700 },
    { label: 'LIQUIDITY', value: brief.liquidityLabel, left: 580, top: 700 },
    { label: 'VOLUME (24H)', value: brief.volumeLabel, left: 64, top: 800 },
    { label: 'AI SCORE', value: brief.aiScoreLabel, left: 580, top: 800 },
    { label: 'ENTRY', value: brief.entryLabel, left: 64, top: 900 },
    { label: 'EXIT', value: brief.exitLabel, left: 580, top: 900 },
  ];

  const [bg, chrome, tag, name, roi, pnl, cells, logo] = await Promise.all([
    renderBackground(roiColor),
    renderChromeLayers(),
    renderTextLayer({
      text: brief.categoryTag,
      color: THEME.accent,
      fontFile: FONTS.monoSemiBold,
      width: 760,
      height: 34,
      align: 'left',
      letterSpacing: 1800,
    }),
    renderTextLayer({
      text: `${brief.tokenName} (${brief.tokenSymbol})`,
      color: THEME.ink,
      fontFile: FONTS.displayBlack,
      width: 850,
      height: 110,
      align: 'left',
    }),
    renderTextLayer({
      text: brief.roiLabel,
      color: roiColor,
      fontFile: FONTS.monoBold,
      width: 950,
      height: 200,
      align: 'left',
    }),
    renderTextLayer({
      text: brief.pnlLabel,
      color: THEME.ink,
      fontFile: FONTS.monoSemiBold,
      width: 950,
      height: 50,
      align: 'left',
    }),
    Promise.all(grid.map(renderGridCell)),
    logoBuffer ? circleMaskLogo(logoBuffer) : Promise.resolve(undefined),
  ]);

  return sharp(bg)
    .composite([
      { input: chrome.brand, top: 64, left: 64 },
      ...(logo ? [{ input: logo, top: LOGO_TOP, left: LOGO_LEFT }] : []),
      { input: tag, top: 140, left: 64 },
      { input: name, top: 188, left: 60 },
      { input: roi, top: 320, left: 56 },
      { input: pnl, top: 560, left: 60 },
      ...cells.flatMap((cell) => [
        { input: cell.label, top: cell.top, left: cell.left },
        { input: cell.value, top: cell.top + 32, left: cell.left },
      ]),
      { input: chrome.handle, top: CANVAS_SIZE - 76, left: 64 },
    ])
    .png()
    .toBuffer();
}
