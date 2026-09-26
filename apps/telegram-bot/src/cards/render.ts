import sharp from 'sharp';

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;

// --- Shared primitives -----------------------------------------------------

/** XML-escapes any dynamic (chain/API-derived) string before it goes into the SVG. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function truncateText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function shortAddr(s: string): string {
  return s.length <= 12 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function formatHoldingTime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(ms / 1000)}s`;
}

export interface RiskRating {
  label: 'Low' | 'Medium' | 'High';
  color: string;
}

/**
 * Derived entirely from real, already-computed risk flags (RiskAnalyzer) — not a
 * new detection system, just a single human-readable rating instead of five
 * separate booleans. Each flag that indicates elevated risk adds one point;
 * 0 points -> Low, 1 -> Medium, 2+ -> High.
 */
export function computeRiskRating(flags: {
  isHoneypotSuspected?: boolean;
  mintAuthorityRevoked?: boolean;
  freezeAuthorityRevoked?: boolean;
  lpBurnedOrLocked?: boolean;
  top10HolderPercent?: number;
}): RiskRating {
  let points = 0;
  if (flags.isHoneypotSuspected) points += 2;
  if (flags.mintAuthorityRevoked === false) points += 1;
  if (flags.freezeAuthorityRevoked === false) points += 1;
  if (flags.lpBurnedOrLocked === false) points += 1;
  if ((flags.top10HolderPercent ?? 0) > 50) points += 1;

  if (points === 0) return { label: 'Low', color: '#22d97a' };
  if (points <= 2) return { label: 'Medium', color: '#f5b942' };
  return { label: 'High', color: '#f5433c' };
}

/**
 * Best-effort logo fetch: real DexScreener-provided image, embedded as a data URI
 * so the whole card renders in one SVG-to-PNG pass. Never throws — a missing/
 * unreachable logo falls back to a placeholder in the SVG template, it never
 * blocks or breaks card generation (a notification is still better with a
 * placeholder than not sent at all).
 */
export async function fetchLogoDataUri(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return undefined;
    const contentType = res.headers.get('content-type') ?? 'image/png';
    if (!contentType.startsWith('image/')) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    // Re-encode through sharp: normalizes format/strips metadata, and guarantees
    // whatever bytes we embed are actually a valid raster image the SVG renderer
    // can decode, regardless of what the remote server claims.
    const png = await sharp(buf).resize(160, 160, { fit: 'cover' }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return undefined;
  }
}

// --- Theme -------------------------------------------------------------------

interface Theme {
  accent: string;
  accentSoft: string;
  glow: string;
}

const PROFIT_THEME: Theme = { accent: '#22d97a', accentSoft: '#7cf5b6', glow: '#0f5c34' };
const LOSS_THEME: Theme = { accent: '#f5433c', accentSoft: '#ff8f89', glow: '#5c1512' };
const NEUTRAL_THEME: Theme = { accent: '#4f8cff', accentSoft: '#9dc0ff', glow: '#12305c' };

function cardShell(theme: Theme, bodySvg: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0e17"/>
      <stop offset="100%" stop-color="#141a2e"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="0%" r="75%">
      <stop offset="0%" stop-color="${theme.glow}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${theme.glow}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.07"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.03"/>
    </linearGradient>
    <filter id="softBlur" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="40"/>
    </filter>
    <clipPath id="logoClip"><circle cx="0" cy="0" r="56"/></clipPath>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#bg)"/>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow)"/>
  ${bodySvg}
  <text x="${CARD_WIDTH / 2}" y="${CARD_HEIGHT - 40}" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" fill="#5b6478" letter-spacing="2">GSP BANK SNIPER</text>
</svg>`;
}

function glassPanel(x: number, y: number, w: number, h: number, theme: Theme): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="url(#panel)" stroke="${theme.accent}" stroke-opacity="0.25" stroke-width="1.5"/>`;
}

/** One label/value row inside a stat grid — two columns, `col` 0 or 1. */
function statCell(x: number, y: number, label: string, value: string): string {
  return `
    <text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="22" fill="#8992a8">${escapeXml(label)}</text>
    <text x="${x}" y="${y + 34}" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#f0f2f8">${escapeXml(value)}</text>`;
}

function statGrid(startY: number, rows: [string, string][]): { svg: string; endY: number } {
  const colX = [80, 570];
  const rowHeight = 108;
  let svg = '';
  rows.forEach((row, i) => {
    const col = i % 2;
    const rowIdx = Math.floor(i / 2);
    const [label, value] = row;
    svg += statCell(colX[col]!, startY + rowIdx * rowHeight, label, value);
  });
  const rowCount = Math.ceil(rows.length / 2);
  return { svg, endY: startY + rowCount * rowHeight };
}

function logoBlock(x: number, y: number, symbol: string, logoDataUri: string | undefined): string {
  if (logoDataUri) {
    return `<g transform="translate(${x},${y})">
      <circle r="58" fill="#1c2338"/>
      <image href="${logoDataUri}" x="-56" y="-56" width="112" height="112" clip-path="url(#logoClip)"/>
    </g>`;
  }
  const initial = escapeXml((symbol || '?').slice(0, 1).toUpperCase());
  return `<g transform="translate(${x},${y})">
    <circle r="58" fill="#1c2338"/>
    <text x="0" y="16" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" font-weight="700" fill="#6b7690">${initial}</text>
  </g>`;
}

function header(icon: string, title: string, theme: Theme): string {
  return `
    <text x="80" y="120" font-family="Arial, sans-serif" font-size="40" font-weight="800" fill="${theme.accent}">${icon} ${escapeXml(title)}</text>
    <rect x="80" y="145" width="200" height="6" rx="3" fill="${theme.accent}"/>`;
}

// --- Buy card ------------------------------------------------------------

export interface TradeCardTokenInfo {
  mint: string;
  name?: string;
  symbol?: string;
  dex: string;
  imageUrl?: string;
  marketCapUsd?: number;
  liquidityUsd?: number;
  aiScore?: number;
  holderCount?: number;
  priceChangeH1?: number;
  isHoneypotSuspected?: boolean;
  mintAuthorityRevoked?: boolean;
  freezeAuthorityRevoked?: boolean;
  lpBurnedOrLocked?: boolean;
  top10HolderPercent?: number;
}

export interface BuyCardData {
  token: TradeCardTokenInfo;
  entryPriceUsd: number;
  amountSol: number;
  estimatedUsdValue?: number;
  walletPublicKey: string;
  positionId: string;
  signature: string;
  timestamp: Date;
}

function fmtUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtPrice(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n === 0) return '—';
  return `$${n.toFixed(8)}`;
}

export function buildBuyCardSvg(data: BuyCardData, logoDataUri: string | undefined): string {
  const theme = PROFIT_THEME;
  const t = data.token;
  const risk = computeRiskRating(t);
  const name = truncateText(t.name || t.symbol || t.mint.slice(0, 8), 22);
  const symbol = t.symbol ? `$${truncateText(t.symbol, 12)}` : '';

  let body = header('🟢', 'BUY EXECUTED', theme);
  body += logoBlock(140, 250, t.symbol ?? '', logoDataUri);
  body += `
    <text x="230" y="238" font-family="Arial, sans-serif" font-size="38" font-weight="700" fill="#f0f2f8">${escapeXml(name)}</text>
    <text x="230" y="280" font-family="Arial, sans-serif" font-size="28" fill="#8992a8">${escapeXml(symbol)}</text>
    <rect x="230" y="298" width="${44 + t.dex.length * 15}" height="40" rx="20" fill="${theme.accent}" fill-opacity="0.15"/>
    <text x="252" y="325" font-family="Arial, sans-serif" font-size="22" font-weight="600" fill="${theme.accent}">${escapeXml(t.dex)}</text>`;

  body += glassPanel(60, 400, 960, 620, theme);
  const { svg: gridSvg } = statGrid(470, [
    ['Entry Price', fmtPrice(data.entryPriceUsd)],
    ['Buy Amount', `${data.amountSol.toFixed(4)} SOL`],
    ['Est. USD Value', fmtUsd(data.estimatedUsdValue)],
    ['Market Cap', fmtUsd(t.marketCapUsd)],
    ['Liquidity', fmtUsd(t.liquidityUsd)],
    ['AI Score', t.aiScore !== undefined ? `${t.aiScore.toFixed(0)}/100` : '—'],
    ['Risk Rating', risk.label],
    ['Whale Activity', 'N/A'],
    ['Top Holders', t.holderCount !== undefined ? `${t.holderCount}` : '—'],
    [
      'Momentum (1h)',
      t.priceChangeH1 !== undefined
        ? `${t.priceChangeH1 >= 0 ? '+' : ''}${t.priceChangeH1.toFixed(1)}%`
        : '—',
    ],
  ]);
  body += gridSvg;

  body += `
    <text x="80" y="1090" font-family="Arial, sans-serif" font-size="20" fill="#5b6478">Wallet: ${escapeXml(shortAddr(data.walletPublicKey))}   ·   Position: ${escapeXml(shortAddr(data.positionId))}</text>
    <text x="80" y="1122" font-family="Arial, sans-serif" font-size="20" fill="#5b6478">Tx: ${escapeXml(shortAddr(data.signature))}   ·   ${escapeXml(data.timestamp.toISOString().slice(0, 16).replace('T', ' '))} UTC</text>`;

  return cardShell(theme, body);
}

export async function renderBuyCardPng(data: BuyCardData): Promise<Buffer> {
  const logoDataUri = await fetchLogoDataUri(data.token.imageUrl);
  return sharp(Buffer.from(buildBuyCardSvg(data, logoDataUri)))
    .png()
    .toBuffer();
}

// --- Sell card -----------------------------------------------------------

export interface SellCardData {
  token: TradeCardTokenInfo;
  entryPriceUsd: number;
  exitPriceUsd: number;
  buyAmountSol: number;
  sellAmountSol: number;
  profitSol: number;
  profitUsd: number;
  roiPercent: number;
  pnlPercent: number;
  holdingTimeMs: number;
  exitReason:
    'take_profit' | 'stop_loss' | 'trailing_stop' | 'manual' | 'emergency' | 'manual_emergency';
  highestProfitPercent?: number;
  lockedProfitPercent?: number;
  walletPublicKey: string;
  positionId: string;
  buySignature: string;
  sellSignature: string;
}

const EXIT_REASON_LABELS: Record<SellCardData['exitReason'], string> = {
  take_profit: 'Take Profit',
  stop_loss: 'Stop Loss',
  trailing_stop: 'Trailing Stop',
  manual: 'Manual Sell',
  emergency: 'Emergency Sell',
  manual_emergency: 'Manual Emergency Sell',
};

export function buildSellCardSvg(data: SellCardData, logoDataUri: string | undefined): string {
  const isProfit = data.pnlPercent >= 0;
  const theme = isProfit ? PROFIT_THEME : LOSS_THEME;
  const t = data.token;
  const risk = computeRiskRating(t);
  const name = truncateText(t.name || t.symbol || t.mint.slice(0, 8), 22);
  const symbol = t.symbol ? `$${truncateText(t.symbol, 12)}` : '';

  let body = header(isProfit ? '🟢' : '🔴', 'POSITION CLOSED', theme);
  body += logoBlock(140, 250, t.symbol ?? '', logoDataUri);
  body += `
    <text x="230" y="238" font-family="Arial, sans-serif" font-size="38" font-weight="700" fill="#f0f2f8">${escapeXml(name)}</text>
    <text x="230" y="280" font-family="Arial, sans-serif" font-size="28" fill="#8992a8">${escapeXml(symbol)}</text>
    <rect x="230" y="298" width="${44 + t.dex.length * 15}" height="40" rx="20" fill="${theme.accent}" fill-opacity="0.15"/>
    <text x="252" y="325" font-family="Arial, sans-serif" font-size="22" font-weight="600" fill="${theme.accent}">${escapeXml(t.dex)}</text>`;

  body += `
    <text x="700" y="270" text-anchor="end" font-family="Arial, sans-serif" font-size="56" font-weight="800" fill="${theme.accent}">${isProfit ? '+' : ''}${data.pnlPercent.toFixed(1)}%</text>
    <text x="700" y="305" text-anchor="end" font-family="Arial, sans-serif" font-size="24" fill="#8992a8">PnL</text>`;

  body += glassPanel(60, 400, 960, 760, theme);
  const { svg: gridSvg } = statGrid(470, [
    ['Entry Price', fmtPrice(data.entryPriceUsd)],
    ['Exit Price', fmtPrice(data.exitPriceUsd)],
    ['Buy Amount', `${data.buyAmountSol.toFixed(4)} SOL`],
    ['Sell Amount', `${data.sellAmountSol.toFixed(4)} SOL`],
    ['Profit', `${data.profitSol >= 0 ? '+' : ''}${data.profitSol.toFixed(4)} SOL`],
    ['Profit (USD)', `${data.profitUsd >= 0 ? '+' : '-'}${fmtUsd(Math.abs(data.profitUsd))}`],
    ['ROI', `${data.roiPercent >= 0 ? '+' : ''}${data.roiPercent.toFixed(1)}%`],
    ['Holding Time', formatHoldingTime(data.holdingTimeMs)],
    ['Exit Reason', EXIT_REASON_LABELS[data.exitReason]],
    [
      'Highest Profit',
      data.highestProfitPercent !== undefined
        ? `${data.highestProfitPercent >= 0 ? '+' : ''}${data.highestProfitPercent.toFixed(1)}%`
        : '—',
    ],
    [
      'Locked Profit',
      data.lockedProfitPercent !== undefined
        ? `${data.lockedProfitPercent >= 0 ? '+' : ''}${data.lockedProfitPercent.toFixed(1)}%`
        : '—',
    ],
    ['AI Score', t.aiScore !== undefined ? `${t.aiScore.toFixed(0)}/100` : '—'],
    ['Risk Rating', risk.label],
  ]);
  body += gridSvg;

  body += `
    <text x="80" y="1220" font-family="Arial, sans-serif" font-size="20" fill="#5b6478">Wallet: ${escapeXml(shortAddr(data.walletPublicKey))}   ·   Position: ${escapeXml(shortAddr(data.positionId))}</text>
    <text x="80" y="1252" font-family="Arial, sans-serif" font-size="20" fill="#5b6478">Buy Tx: ${escapeXml(shortAddr(data.buySignature))}   ·   Sell Tx: ${escapeXml(shortAddr(data.sellSignature))}</text>`;

  return cardShell(theme, body);
}

export async function renderSellCardPng(data: SellCardData): Promise<Buffer> {
  const logoDataUri = await fetchLogoDataUri(data.token.imageUrl);
  return sharp(Buffer.from(buildSellCardSvg(data, logoDataUri)))
    .png()
    .toBuffer();
}

export { NEUTRAL_THEME };
