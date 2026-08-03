import sharp from 'sharp';
import { renderBackground } from './background.js';
import { renderChromeLayers } from './chrome.js';
import { renderTextLayer } from './textLayer.js';
import { CANVAS_SIZE, FONTS, THEME } from './theme.js';

export interface HeadlineCardBrief {
  /** Short headline, ideally under ~60 characters — already vetted by the
   * copy generator's no-fabrication rules, this renderer just lays it out. */
  headline: string;
  /** Short uppercase category tag, e.g. "TRADING TIP", "SECURITY ALERT",
   * "REFERRAL PROGRAM", "ANNOUNCEMENT". */
  tag: string;
  /** Defaults to the brand accent — pass THEME.warning for security/
   * honeypot-education content so it visually reads as distinct from an
   * ordinary promotional post. */
  tagColor?: string;
}

/** General-purpose branded card for any category that has no numeric stat
 * to lead with — a short headline + category tag, always available since it
 * only ever needs the post's own already-generated title.
 *
 * `customBackground` is how the AI_GENERATED visual type reuses this exact
 * same layout: an AI image model is unreliable at rendering our own crisp,
 * on-brand, guaranteed-legible text (see render.ts's own doc comment), so
 * the AI's output is used only as this card's background — pre-resized to
 * CANVAS_SIZE×CANVAS_SIZE by the caller — while brand/tag/headline are still
 * this module's own proven text compositing on top of it. */
export async function renderHeadlineCard(
  brief: HeadlineCardBrief,
  customBackground?: Buffer,
): Promise<Buffer> {
  const tagColor = brief.tagColor ?? THEME.accent;
  const [bg, chrome, tag, headline] = await Promise.all([
    customBackground ? Promise.resolve(customBackground) : renderBackground(tagColor),
    renderChromeLayers(),
    renderTextLayer({
      text: brief.tag,
      color: tagColor,
      fontFile: FONTS.monoSemiBold,
      width: 950,
      height: 34,
      align: 'left',
      letterSpacing: 1800,
    }),
    renderTextLayer({
      text: brief.headline,
      color: THEME.ink,
      fontFile: FONTS.displayBlack,
      width: 950,
      height: 460,
      align: 'left',
    }),
  ]);

  return sharp(bg)
    .composite([
      { input: chrome.brand, top: 64, left: 64 },
      { input: tag, top: 420, left: 64 },
      { input: headline, top: 470, left: 60 },
      { input: chrome.handle, top: CANVAS_SIZE - 76, left: 64 },
    ])
    .png()
    .toBuffer();
}
