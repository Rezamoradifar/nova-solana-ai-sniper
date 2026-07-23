import { renderTextLayer } from './textLayer.js';
import { BRAND_HANDLE, BRAND_WORDMARK, FONTS, THEME } from './theme.js';

/** The two elements every card template shares (brand wordmark top-left,
 * channel handle bottom-left) — factored out so both templates render the
 * exact same brand chrome rather than two near-identical copies drifting
 * apart over time. */
export async function renderChromeLayers(): Promise<{ brand: Buffer; handle: Buffer }> {
  const [brand, handle] = await Promise.all([
    renderTextLayer({
      text: BRAND_WORDMARK,
      color: THEME.accent,
      fontFile: FONTS.monoSemiBold,
      width: 700,
      height: 34,
      align: 'left',
      letterSpacing: 2200,
    }),
    renderTextLayer({
      text: BRAND_HANDLE,
      color: THEME.inkMuted,
      fontFile: FONTS.monoMedium,
      width: 500,
      height: 28,
      align: 'left',
    }),
  ]);
  return { brand, handle };
}
