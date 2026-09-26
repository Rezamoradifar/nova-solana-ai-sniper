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

const PROFIT_THEME: Theme = { accent: '#22d97a', accentSoft: '#a6f7cf', glow: '#1fbf6c' };
const LOSS_THEME: Theme = { accent: '#f5433c', accentSoft: '#ffb3ae', glow: '#e0342d' };
const NEUTRAL_THEME: Theme = { accent: '#4f8cff', accentSoft: '#b9d1ff', glow: '#3a6fe0' };

// Bundled into the runtime images (see the Dockerfiles); DejaVu is the fallback.
const SANS = "Vazirmatn, 'DejaVu Sans', sans-serif";
const MONO = "'JetBrains Mono', 'DejaVu Sans Mono', monospace";
const TEXT = '#f2f4fa';
const MUTED = '#7d879e';
const FAINT = '#4a5369';

/** Rough advance width, good enough to size pills and fit headline numbers. */
function approxWidth(text: string, fontSize: number, mono = false): number {
  return text.length * fontSize * (mono ? 0.6 : 0.56);
}

function fitFontSize(text: string, maxWidth: number, maxSize: number, mono = true): number {
  const size = maxWidth / (text.length * (mono ? 0.6 : 0.56));
  return Math.floor(Math.min(maxSize, size));
}

function cardShell(
  theme: Theme,
  status: string,
  bodySvg: string,
  footer: [string, string],
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <defs>
    <radialGradient id="heroGlow" cx="50%" cy="36%" r="55%">
      <stop offset="0%" stop-color="${theme.glow}" stop-opacity="0.34"/>
      <stop offset="55%" stop-color="${theme.glow}" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="${theme.glow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="dotFade" cx="50%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#fff" stop-opacity="1"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <pattern id="dots" width="34" height="34" patternUnits="userSpaceOnUse">
      <circle cx="17" cy="17" r="1.3" fill="#ffffff" fill-opacity="0.07"/>
    </pattern>
    <mask id="dotMask"><rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#dotFade)"/></mask>
    <linearGradient id="accentText" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${theme.accentSoft}"/>
      <stop offset="100%" stop-color="${theme.accent}"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${theme.accentSoft}"/>
      <stop offset="100%" stop-color="${theme.accent}"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.055"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.02"/>
    </linearGradient>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${theme.accent}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${theme.accent}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="logoClip"><circle cx="0" cy="0" r="44"/></clipPath>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#07090f"/>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#dots)" mask="url(#dotMask)"/>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#heroGlow)"/>
  <rect x="0" y="0" width="${CARD_WIDTH}" height="6" fill="url(#mark)"/>

  <g transform="translate(64,62)">
    <rect width="48" height="48" rx="13" fill="url(#mark)"/>
    <polyline points="11,33 20,24 27,29 37,15" fill="none" stroke="#07090f" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="37" cy="15" r="3.5" fill="#07090f"/>
  </g>
  <text x="128" y="94" font-family="${SANS}" font-size="25" font-weight="700" letter-spacing="4" fill="${TEXT}">GSP BANK SNIPER</text>
  ${pill(CARD_WIDTH - 64, 86, status, theme.accent, 'end', true)}

  ${bodySvg}

  <line x1="64" y1="1262" x2="${CARD_WIDTH - 64}" y2="1262" stroke="#ffffff" stroke-opacity="0.07"/>
  <text x="64" y="1300" font-family="${MONO}" font-size="19" font-weight="500" fill="${FAINT}">${escapeXml(footer[0])}</text>
  <text x="${CARD_WIDTH - 64}" y="1300" text-anchor="end" font-family="${MONO}" font-size="19" font-weight="500" fill="${FAINT}">${escapeXml(footer[1])}</text>
</svg>`;
}

/** Chip width for a 20px semibold label with 1px letter-spacing and 20px padding. */
function pillWidth(label: string): number {
  const caps = label.replace(/[^A-Z0-9%+-]/g, '').length;
  const lower = label.length - caps;
  return Math.round(caps * 14.2 + lower * 11.2 + 40);
}

/**
 * Rounded label chip. `anchor` is where (x) sits: the chip's start, centre or end.
 * With `dot`, a small status dot is drawn before the label.
 */
function pill(
  x: number,
  cy: number,
  label: string,
  color: string,
  anchor: 'start' | 'middle' | 'end' = 'start',
  dot = false,
): string {
  const fontSize = 20;
  const padX = 20;
  const dotSpace = dot ? 20 : 0;
  const w = pillWidth(label) + dotSpace;
  const h = 40;
  const left = anchor === 'start' ? x : anchor === 'middle' ? x - w / 2 : x - w;
  return `<g>
    <rect x="${left}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-opacity="0.35"/>
    ${dot ? `<circle cx="${left + padX + 4}" cy="${cy}" r="5" fill="${color}"/>` : ''}
    <text x="${left + padX + dotSpace}" y="${cy + 7}" font-family="${SANS}" font-size="${fontSize}" font-weight="600" letter-spacing="1" fill="${color}">${escapeXml(label)}</text>
  </g>`;
}

/** A row of pills centred on `cx`. */
function pillRow(cx: number, cy: number, items: { label: string; color: string }[]): string {
  const gap = 14;
  const widths = items.map((i) => pillWidth(i.label));
  const total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
  let x = cx - total / 2;
  return items
    .map((item, idx) => {
      const svg = pill(x, cy, item.label, item.color);
      x += widths[idx]! + gap;
      return svg;
    })
    .join('');
}

function glassPanel(x: number, y: number, w: number, h: number): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="28" fill="url(#panel)" stroke="#ffffff" stroke-opacity="0.08"/>`;
}

/** Stat cells laid out `cols` per row inside a panel, with hairline dividers. */
function statPanel(y: number, cols: number, cells: [string, string, string?][]): string {
  const x = 64;
  const w = CARD_WIDTH - 128;
  const rowH = 104;
  const rows = Math.ceil(cells.length / cols);
  const colW = w / cols;
  let svg = glassPanel(x, y, w, rows * rowH);
  for (let c = 1; c < cols; c++) {
    svg += `<line x1="${x + c * colW}" y1="${y + 22}" x2="${x + c * colW}" y2="${y + rows * rowH - 22}" stroke="#ffffff" stroke-opacity="0.06"/>`;
  }
  for (let r = 1; r < rows; r++) {
    svg += `<line x1="${x + 28}" y1="${y + r * rowH}" x2="${x + w - 28}" y2="${y + r * rowH}" stroke="#ffffff" stroke-opacity="0.06"/>`;
  }
  cells.forEach(([label, value, color], i) => {
    const cx = x + (i % cols) * colW + 30;
    const cy = y + Math.floor(i / cols) * rowH;
    const size = fitFontSize(value, colW - 50, 29);
    svg += `
    <text x="${cx}" y="${cy + 40}" font-family="${SANS}" font-size="17" font-weight="600" letter-spacing="1.5" fill="${MUTED}">${escapeXml(label.toUpperCase())}</text>
    <text x="${cx}" y="${cy + 78}" font-family="${MONO}" font-size="${size}" font-weight="600" fill="${color ?? TEXT}">${escapeXml(value)}</text>`;
  });
  return svg;
}

function logoBlock(
  x: number,
  y: number,
  symbol: string,
  logoDataUri: string | undefined,
  theme: Theme,
): string {
  const ring = `<circle r="50" fill="none" stroke="${theme.accent}" stroke-opacity="0.6" stroke-width="3"/>`;
  if (logoDataUri) {
    return `<g transform="translate(${x},${y})">
      <circle r="44" fill="#161c2c"/>
      <image href="${logoDataUri}" x="-44" y="-44" width="88" height="88" clip-path="url(#logoClip)"/>
      ${ring}
    </g>`;
  }
  const initial = escapeXml((symbol || '?').slice(0, 1).toUpperCase());
  return `<g transform="translate(${x},${y})">
    <circle r="44" fill="#161c2c"/>
    <text x="0" y="14" text-anchor="middle" font-family="${SANS}" font-size="40" font-weight="700" fill="${MUTED}">${initial}</text>
    ${ring}
  </g>`;
}

function tokenRow(t: TradeCardTokenInfo, logoDataUri: string | undefined, theme: Theme): string {
  const name = truncateText(t.name || t.symbol || t.mint.slice(0, 8), 22);
  const symbol = t.symbol ? `$${truncateText(t.symbol, 12)}` : '';
  const symbolW = symbol ? approxWidth(symbol, 24, true) + 18 : 0;
  return `
    ${logoBlock(118, 222, t.symbol ?? '', logoDataUri, theme)}
    <text x="192" y="212" font-family="${SANS}" font-size="44" font-weight="700" fill="${TEXT}">${escapeXml(name)}</text>
    <text x="192" y="256" font-family="${MONO}" font-size="24" font-weight="500" fill="${MUTED}">${escapeXml(symbol)}</text>
    ${pill(192 + symbolW, 248, t.dex, MUTED)}`;
}

function signed(n: number, digits: number, suffix = ''): string {
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(digits)}${suffix}`;
}

function signedUsd(n: number): string {
  return `${n >= 0 ? '+' : '-'}${fmtUsd(Math.abs(n))}`;
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
  const amount = `${data.amountSol.toFixed(4)} SOL`;
  const heroSize = fitFontSize(amount, 900, 128);
  const aiScore = t.aiScore !== undefined ? Math.max(0, Math.min(100, t.aiScore)) : undefined;

  let body = tokenRow(t, logoDataUri, theme);
  body += `
    <text x="${CARD_WIDTH / 2}" y="392" text-anchor="middle" font-family="${SANS}" font-size="22" font-weight="600" letter-spacing="6" fill="${MUTED}">POSITION OPENED</text>
    <text x="${CARD_WIDTH / 2}" y="${392 + heroSize * 1.05}" text-anchor="middle" font-family="${MONO}" font-size="${heroSize}" font-weight="700" fill="url(#accentText)">${escapeXml(amount)}</text>
    <text x="${CARD_WIDTH / 2}" y="${452 + heroSize * 1.05}" text-anchor="middle" font-family="${MONO}" font-size="30" font-weight="500" fill="${TEXT}" xml:space="preserve">≈ ${escapeXml(fmtUsd(data.estimatedUsdValue))}<tspan fill="${FAINT}"> · </tspan><tspan fill="${MUTED}">@ ${escapeXml(fmtPrice(data.entryPriceUsd))}</tspan></text>`;
  body += pillRow(CARD_WIDTH / 2, 700, [
    { label: `Risk ${risk.label}`, color: risk.color },
    ...(t.priceChangeH1 !== undefined
      ? [
          {
            label: `1h ${signed(t.priceChangeH1, 1, '%')}`,
            color: t.priceChangeH1 >= 0 ? PROFIT_THEME.accent : LOSS_THEME.accent,
          },
        ]
      : []),
  ]);

  // AI score gauge.
  body += glassPanel(64, 770, CARD_WIDTH - 128, 170);
  body += `
    <text x="100" y="828" font-family="${SANS}" font-size="17" font-weight="600" letter-spacing="1.5" fill="${MUTED}">AI SCORE</text>
    <text x="${CARD_WIDTH - 100}" y="832" text-anchor="end" font-family="${MONO}" font-size="34" font-weight="700" fill="${TEXT}">${aiScore !== undefined ? `${aiScore.toFixed(0)}/100` : '—'}</text>
    <rect x="100" y="868" width="${CARD_WIDTH - 200}" height="16" rx="8" fill="#ffffff" fill-opacity="0.07"/>
    ${aiScore !== undefined ? `<rect x="100" y="868" width="${Math.max(16, ((CARD_WIDTH - 200) * aiScore) / 100)}" height="16" rx="8" fill="url(#mark)"/>` : ''}
    <text x="100" y="916" font-family="${MONO}" font-size="16" fill="${FAINT}">0</text>
    <text x="${CARD_WIDTH - 100}" y="916" text-anchor="end" font-family="${MONO}" font-size="16" fill="${FAINT}">100</text>`;

  body += statPanel(966, 4, [
    ['Entry Price', fmtPrice(data.entryPriceUsd)],
    ['Market Cap', fmtUsd(t.marketCapUsd)],
    ['Liquidity', fmtUsd(t.liquidityUsd)],
    ['Top Holders', t.holderCount !== undefined ? `${t.holderCount}` : '—'],
    [
      'Top 10 Hold',
      t.top10HolderPercent !== undefined ? `${t.top10HolderPercent.toFixed(1)}%` : '—',
    ],
    [
      'Mint Auth',
      t.mintAuthorityRevoked === undefined ? '—' : t.mintAuthorityRevoked ? 'Revoked' : 'Active',
      t.mintAuthorityRevoked === false ? LOSS_THEME.accent : undefined,
    ],
    [
      'Freeze Auth',
      t.freezeAuthorityRevoked === undefined
        ? '—'
        : t.freezeAuthorityRevoked
          ? 'Revoked'
          : 'Active',
      t.freezeAuthorityRevoked === false ? LOSS_THEME.accent : undefined,
    ],
    [
      'LP',
      t.lpBurnedOrLocked === undefined ? '—' : t.lpBurnedOrLocked ? 'Locked' : 'Unlocked',
      t.lpBurnedOrLocked === false ? LOSS_THEME.accent : undefined,
    ],
  ]);

  const when = data.timestamp.toISOString().slice(0, 16).replace('T', ' ');
  return cardShell(theme, 'BUY EXECUTED', body, [
    `Wallet ${shortAddr(data.walletPublicKey)}  ·  Tx ${shortAddr(data.signature)}`,
    `${when} UTC`,
  ]);
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
    | 'take_profit'
    | 'stop_loss'
    | 'trailing_stop'
    | 'manual'
    | 'emergency'
    | 'manual_emergency'
    | 'time_stop';
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
  time_stop: 'Time Stop',
};

/**
 * Entry -> peak -> exit drawn from the three real PnL points only (0%, highest
 * profit if known, final PnL) — a trade summary, not an intraday price chart.
 */
function tradePath(y: number, h: number, pnl: number, peak: number | undefined): string {
  const x0 = 110;
  const x1 = CARD_WIDTH - 110;
  const pts: { x: number; v: number; label?: string }[] = [{ x: x0, v: 0 }];
  if (peak !== undefined && peak > Math.max(0, pnl)) {
    pts.push({ x: x0 + (x1 - x0) * 0.62, v: peak, label: `PEAK ${signed(peak, 1, '%')}` });
  }
  pts.push({ x: x1, v: pnl });
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const span = hi - lo || 1;
  const top = y + 44;
  const bottom = y + h - 44;
  const py = (v: number) => bottom - ((v - lo) / span) * (bottom - top);

  let d = `M ${pts[0]!.x} ${py(pts[0]!.v)}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const mx = (a.x + b.x) / 2;
    d += ` C ${mx} ${py(a.v)}, ${mx} ${py(b.v)}, ${b.x} ${py(b.v)}`;
  }
  const area = `${d} L ${x1} ${bottom + 30} L ${x0} ${bottom + 30} Z`;
  const zeroY = py(0);

  let svg = `
    <line x1="${x0}" y1="${zeroY}" x2="${x1}" y2="${zeroY}" stroke="#ffffff" stroke-opacity="0.12" stroke-dasharray="6 8"/>
    <path d="${area}" fill="url(#area)"/>
    <path d="${d}" fill="none" stroke="url(#mark)" stroke-width="5" stroke-linecap="round"/>`;
  for (const p of pts) {
    svg += `<circle cx="${p.x}" cy="${py(p.v)}" r="9" fill="#07090f" stroke="${TEXT}" stroke-width="3"/>`;
    if (p.label) {
      svg += `<text x="${p.x}" y="${py(p.v) - 22}" text-anchor="middle" font-family="${MONO}" font-size="18" font-weight="600" fill="${MUTED}">${escapeXml(p.label)}</text>`;
    }
  }
  return svg;
}

export function buildSellCardSvg(data: SellCardData, logoDataUri: string | undefined): string {
  const isProfit = data.pnlPercent >= 0;
  const theme = isProfit ? PROFIT_THEME : LOSS_THEME;
  const t = data.token;
  const risk = computeRiskRating(t);
  const pnlText = signed(data.pnlPercent, 1, '%');
  const heroSize = fitFontSize(pnlText, 920, 184);

  let body = tokenRow(t, logoDataUri, theme);
  body += `
    <text x="${CARD_WIDTH / 2}" y="378" text-anchor="middle" font-family="${SANS}" font-size="22" font-weight="600" letter-spacing="6" fill="${MUTED}">PROFIT / LOSS</text>
    <text x="${CARD_WIDTH / 2}" y="${372 + heroSize * 0.98}" text-anchor="middle" font-family="${MONO}" font-size="${heroSize}" font-weight="700" fill="url(#accentText)">${escapeXml(pnlText)}</text>
    <text x="${CARD_WIDTH / 2}" y="${436 + heroSize * 0.98}" text-anchor="middle" font-family="${MONO}" font-size="36" font-weight="600" fill="${TEXT}" xml:space="preserve">${escapeXml(signed(data.profitSol, 4, ' SOL'))}<tspan fill="${FAINT}"> · </tspan><tspan fill="${theme.accentSoft}">${escapeXml(signedUsd(data.profitUsd))}</tspan></text>`;
  body += pillRow(CARD_WIDTH / 2, 690, [
    { label: EXIT_REASON_LABELS[data.exitReason], color: theme.accent },
    { label: `Held ${formatHoldingTime(data.holdingTimeMs)}`, color: MUTED },
  ]);

  body += glassPanel(64, 740, CARD_WIDTH - 128, 230);
  body += tradePath(740, 230, data.pnlPercent, data.highestProfitPercent);
  body += `
    <text x="100" y="1000" font-family="${SANS}" font-size="16" font-weight="600" letter-spacing="1.5" fill="${MUTED}">ENTRY <tspan font-family="${MONO}" fill="${TEXT}">${escapeXml(fmtPrice(data.entryPriceUsd))}</tspan></text>
    <text x="${CARD_WIDTH - 100}" y="1000" text-anchor="end" font-family="${SANS}" font-size="16" font-weight="600" letter-spacing="1.5" fill="${MUTED}">EXIT <tspan font-family="${MONO}" fill="${TEXT}">${escapeXml(fmtPrice(data.exitPriceUsd))}</tspan></text>`;

  const pct = (n: number | undefined) => (n !== undefined ? signed(n, 1, '%') : '—');
  const priceMove =
    data.entryPriceUsd > 0 && data.exitPriceUsd > 0
      ? signed(((data.exitPriceUsd - data.entryPriceUsd) / data.entryPriceUsd) * 100, 1, '%')
      : '—';
  body += statPanel(1030, 4, [
    ['Invested', `${data.buyAmountSol.toFixed(4)} SOL`],
    ['Returned', `${data.sellAmountSol.toFixed(4)} SOL`],
    ['Highest Profit', pct(data.highestProfitPercent)],
    ['Locked Profit', pct(data.lockedProfitPercent)],
  ]);
  body += `
    <text x="100" y="1178" font-family="${SANS}" font-size="17" font-weight="600" letter-spacing="1.5" fill="${MUTED}">PRICE <tspan font-family="${MONO}" font-size="22" fill="${TEXT}">${escapeXml(priceMove)}</tspan></text>
    <text x="${CARD_WIDTH / 2}" y="1178" text-anchor="middle" font-family="${SANS}" font-size="17" font-weight="600" letter-spacing="1.5" fill="${MUTED}">AI SCORE <tspan font-family="${MONO}" font-size="22" fill="${TEXT}">${t.aiScore !== undefined ? `${t.aiScore.toFixed(0)}/100` : '—'}</tspan></text>
    <text x="${CARD_WIDTH - 100}" y="1178" text-anchor="end" font-family="${SANS}" font-size="17" font-weight="600" letter-spacing="1.5" fill="${MUTED}">RISK <tspan font-size="22" fill="${risk.color}">${risk.label}</tspan></text>`;

  return cardShell(theme, 'POSITION CLOSED', body, [
    `Wallet ${shortAddr(data.walletPublicKey)}  ·  Buy ${shortAddr(data.buySignature)}`,
    `Sell ${shortAddr(data.sellSignature)}`,
  ]);
}

export async function renderSellCardPng(data: SellCardData): Promise<Buffer> {
  const logoDataUri = await fetchLogoDataUri(data.token.imageUrl);
  return sharp(Buffer.from(buildSellCardSvg(data, logoDataUri)))
    .png()
    .toBuffer();
}

export { NEUTRAL_THEME };
