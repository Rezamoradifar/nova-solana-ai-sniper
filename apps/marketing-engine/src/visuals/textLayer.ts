import sharp from 'sharp';

/** Escapes the characters Pango markup treats as syntax — same character set
 * XML escaping needs, since Pango markup is itself an XML-like mini-syntax.
 * Every text layer's raw string goes through this before being wrapped in a
 * `<span>`, since AI-generated copy is untrusted input as far as this
 * renderer is concerned (same reasoning cards/render.ts's escapeXml already
 * documents for its own SVG `<text>` elements). */
export function escapeMarkup(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface TextLayerOptions {
  text: string;
  color: string;
  fontFile: string;
  /** Pixel box the text is laid out and auto-fit within — see this file's
   * own module doc comment on why width+height (not a point size) is how
   * every layer's rendered size is actually controlled. */
  width: number;
  height: number;
  align?: 'left' | 'centre' | 'right';
  /** Pango letter-spacing units (1/1024 pt) — used for the tracked-uppercase
   * look on labels/the brand wordmark, matching the presentation's own
   * typographic convention. */
  letterSpacing?: number;
}

/**
 * Renders one line/block of text to a transparent PNG buffer via sharp's
 * Pango-backed text renderer with a specific embedded font file — proven
 * live (2026-07-23) to render the actual requested font, not a system
 * fallback, unlike embedding @font-face in an SVG string (librsvg's CSS
 * font support is inconsistent across builds). Width/height together
 * auto-fit the font size to the box (sharp's own documented behavior for
 * `create.text` when both are given), which is what makes a short label and
 * a long label render at a visually consistent size without this module
 * needing to compute point sizes itself.
 */
export async function renderTextLayer(opts: TextLayerOptions): Promise<Buffer> {
  const spacingAttr = opts.letterSpacing ? ` letter_spacing="${opts.letterSpacing}"` : '';
  const markup = `<span foreground="${opts.color}"${spacingAttr}>${escapeMarkup(opts.text)}</span>`;
  return sharp({
    text: {
      text: markup,
      fontfile: opts.fontFile,
      rgba: true,
      width: opts.width,
      height: opts.height,
      align: opts.align ?? 'left',
      wrap: 'word',
    },
  })
    .png()
    .toBuffer();
}
