import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GSP Bank Sniper brand identity for generated marketing visuals —
 * deliberately the same palette as the project's investor presentation
 * (docs/presentation/interactive-fa.html) so every public-facing asset reads
 * as one consistent brand, not a one-off. Distinct from cards/render.ts's
 * profit/loss trade-card theme in apps/telegram-bot (green/red by design,
 * a different job — reporting an outcome, not brand marketing).
 */
export const THEME = {
  bg: '#0B0C13',
  bgElevated: '#14151F',
  ink: '#F4F2FA',
  inkMuted: '#9B98B3',
  accent: '#8C6FFF',
  signal: '#35E8B0',
  /** Reserved for security/warning content — semantically distinct from the
   * brand accent, never used for ordinary posts. */
  warning: '#FF8A65',
  line: 'rgba(140,111,255,0.35)',
} as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

export const FONTS = {
  displayBlack: path.join(FONT_DIR, 'Vazirmatn-Black.ttf'),
  displayBold: path.join(FONT_DIR, 'Vazirmatn-Bold.ttf'),
  displaySemiBold: path.join(FONT_DIR, 'Vazirmatn-SemiBold.ttf'),
  displayMedium: path.join(FONT_DIR, 'Vazirmatn-Medium.ttf'),
  monoBold: path.join(FONT_DIR, 'JetBrainsMono-Bold.ttf'),
  monoSemiBold: path.join(FONT_DIR, 'JetBrainsMono-SemiBold.ttf'),
  monoMedium: path.join(FONT_DIR, 'JetBrainsMono-Medium.ttf'),
} as const;

export const CANVAS_SIZE = 1080;

export const BRAND_WORDMARK = 'GSP BANK SNIPER';
export const BRAND_HANDLE = 't.me/SolanaSniperAI';
