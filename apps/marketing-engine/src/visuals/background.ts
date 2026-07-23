import sharp from 'sharp';
import { CANVAS_SIZE, THEME } from './theme.js';

/**
 * The decorative shell (gradient glow, radar rings, corner brackets, footer
 * divider) — pure vector shapes only, no `<text>`, so it never depends on
 * librsvg's inconsistent embedded-font support (see textLayer.ts's own doc
 * comment for why text is rendered separately and composited on top).
 */
export function buildBackgroundSvg(glowColor: string = THEME.accent): string {
  const s = CANVAS_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="8%" r="60%">
      <stop offset="0%" stop-color="${glowColor}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${glowColor}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="corner-glow" cx="100%" cy="100%" r="45%">
      <stop offset="0%" stop-color="${THEME.signal}" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="${THEME.signal}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${s}" height="${s}" fill="${THEME.bg}"/>
  <rect width="${s}" height="${s}" fill="url(#glow)"/>
  <rect width="${s}" height="${s}" fill="url(#corner-glow)"/>

  <!-- radar rings, bottom-right, very subtle -->
  <g stroke="${THEME.line}" stroke-width="1.5" fill="none" opacity="0.5">
    <circle cx="${s - 60}" cy="${s - 60}" r="90"/>
    <circle cx="${s - 60}" cy="${s - 60}" r="150"/>
    <circle cx="${s - 60}" cy="${s - 60}" r="210"/>
  </g>

  <!-- corner brackets (targeting motif) — kept tight in the very corner so
  they never collide with the brand wordmark/footer text composited at
  top:64/left:64 and bottom-left respectively. -->
  <g stroke="${THEME.accent}" stroke-width="3" fill="none" opacity="0.85">
    <path d="M 32 64 L 32 32 L 64 32"/>
    <path d="M ${s - 64} ${s - 32} L ${s - 32} ${s - 32} L ${s - 32} ${s - 64}"/>
  </g>

  <!-- footer hairline divider -->
  <line x1="64" y1="${s - 96}" x2="${s - 64}" y2="${s - 96}" stroke="${THEME.line}" stroke-width="1.5"/>
</svg>`;
}

export async function renderBackground(glowColor?: string): Promise<Buffer> {
  return sharp(Buffer.from(buildBackgroundSvg(glowColor)))
    .png()
    .toBuffer();
}
