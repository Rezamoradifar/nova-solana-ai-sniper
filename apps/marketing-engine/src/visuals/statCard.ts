import sharp from 'sharp';
import { renderBackground } from './background.js';
import { renderChromeLayers } from './chrome.js';
import { renderTextLayer } from './textLayer.js';
import { CANVAS_SIZE, FONTS, THEME } from './theme.js';

/** Every field here must trace back to a real, verified number the caller
 * already has (see marketContext.ts) — this renderer has no data source of
 * its own and never invents a figure. */
export interface StatCardBrief {
  /** The headline figure, pre-formatted as a string (e.g. "79", "+4.2%") —
   * formatting (sign, decimals, units) is the caller's decision, not this
   * renderer's. */
  bigNumber: string;
  label: string;
  sublabel: string;
}

/** Infographic-style card: one large verified number as the visual's entire
 * point, matching the brief's own worked example ("79 / NEW TOKENS SCREENED
 * / 24H SOLANA MEMECOIN PULSE"). */
export async function renderStatCard(brief: StatCardBrief): Promise<Buffer> {
  const [bg, chrome, number, label, sublabel] = await Promise.all([
    renderBackground(),
    renderChromeLayers(),
    renderTextLayer({
      text: brief.bigNumber,
      color: THEME.ink,
      fontFile: FONTS.monoBold,
      width: 950,
      height: 340,
      align: 'left',
    }),
    renderTextLayer({
      text: brief.label,
      color: THEME.accent,
      fontFile: FONTS.displayBold,
      width: 950,
      height: 76,
      align: 'left',
      letterSpacing: 400,
    }),
    renderTextLayer({
      text: brief.sublabel,
      color: THEME.inkMuted,
      fontFile: FONTS.monoMedium,
      width: 950,
      height: 40,
      align: 'left',
    }),
  ]);

  return sharp(bg)
    .composite([
      { input: chrome.brand, top: 64, left: 64 },
      { input: number, top: 330, left: 56 },
      { input: label, top: 670, left: 64 },
      { input: sublabel, top: 748, left: 64 },
      { input: chrome.handle, top: CANVAS_SIZE - 76, left: 64 },
    ])
    .png()
    .toBuffer();
}
