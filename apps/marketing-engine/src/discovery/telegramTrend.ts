import { PublicKey } from '@solana/web3.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Trimmed duplicate of apps/api/src/social/telegramTrend.ts's extraction
 * logic (2026-07-31) — deliberately NOT a shared import. Same "duplicate,
 * don't cross-import" isolation convention as marketData.ts/tradeShowcase/
 * data.ts/activityFeed/data.ts: this module feeds ONLY the ecosystemFeed
 * content pipeline (outbound posts), never apps/api's live buy-candidate
 * pipeline, so a bug here can never affect trading. A discovered mint from
 * here must still clear a real DexScreener liquidity check and the
 * standalone rule-based risk score (see riskScore.ts) before it's eligible
 * for a post, and the source message's text is never copied into any post —
 * this module only ever extracts a candidate mint address.
 */
const BASE58_ADDR = '[1-9A-HJ-NP-Za-km-z]{32,44}';

const MINT_LINK_PATTERNS: RegExp[] = [
  new RegExp(`dexscreener\\.com/solana/(${BASE58_ADDR})`, 'gi'),
  new RegExp(`solscan\\.io/token/(${BASE58_ADDR})`, 'gi'),
  new RegExp(`pump\\.fun/coin/(${BASE58_ADDR})`, 'gi'),
  new RegExp(`birdeye\\.so/token/(${BASE58_ADDR})`, 'gi'),
  new RegExp(`jup\\.ag/swap/SOL-(${BASE58_ADDR})`, 'gi'),
];

const BARE_CA_PATTERN = new RegExp(
  `\\b(?:CA|Contract|Mint)\\s*[:\\-]?\\s*(${BASE58_ADDR})\\b`,
  'gi',
);

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isValidMintFormat(candidate: string): boolean {
  try {
    new PublicKey(candidate);
    return true;
  } catch {
    return false;
  }
}

export function extractMintCandidates(messageHtml: string): string[] {
  const found = new Set<string>();

  for (const pattern of MINT_LINK_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(messageHtml))) {
      if (match[1]) found.add(match[1]);
    }
  }

  const plainText = stripHtml(messageHtml);
  BARE_CA_PATTERN.lastIndex = 0;
  let bareMatch: RegExpExecArray | null;
  while ((bareMatch = BARE_CA_PATTERN.exec(plainText))) {
    if (bareMatch[1]) found.add(bareMatch[1]);
  }

  const candidates: string[] = [];
  for (const candidate of found) {
    if (candidate === SOL_MINT) continue;
    if (!isValidMintFormat(candidate)) continue;
    candidates.push(candidate);
  }
  return candidates;
}

export interface EcosystemTelegramSignal {
  channel: string;
  messageId: number;
  messageUrl: string;
  mints: string[];
}

interface MessageBlock {
  channel: string;
  id: number;
  html: string;
}

function splitMessageBlocks(html: string): MessageBlock[] {
  const markerRe = /<div class="tgme_widget_message[^"]*"\s+data-post="([a-zA-Z0-9_]+)\/(\d+)"/g;
  const marks: { index: number; channel: string; id: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = markerRe.exec(html))) {
    if (!match[1] || !match[2]) continue;
    marks.push({ index: match.index, channel: match[1], id: Number(match[2]) });
  }
  return marks.map((mark, i) => {
    const next = marks[i + 1];
    return {
      channel: mark.channel,
      id: mark.id,
      html: html.slice(mark.index, next ? next.index : html.length),
    };
  });
}

/**
 * Reads a public Telegram channel's message preview
 * (https://t.me/s/<channel>) — no bot membership, no login, no API
 * credentials. Best-effort: Telegram's HTML markup here is external and
 * unversioned. Pattern coverage confirmed against trendingssol/trending
 * (see apps/api's original); soltrenchtrending/solwhaletrending use the
 * same public preview mechanism but their exact markup hasn't been
 * separately verified yet — the extraction patterns above are link/text
 * based, not channel-specific, so they're expected to generalize, but this
 * is worth a real dry-run check per new channel before enabling.
 */
export class EcosystemTelegramTrendClient {
  async fetchMessages(
    channel: string,
    afterMessageId?: number,
  ): Promise<EcosystemTelegramSignal[]> {
    const res = await fetch(`https://t.me/s/${encodeURIComponent(channel)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GSPBankSniperBot/1.0)' },
    });
    if (!res.ok) {
      throw new Error(`Telegram channel preview fetch failed for ${channel}: ${res.status}`);
    }
    const html = await res.text();
    const blocks = splitMessageBlocks(html);

    return blocks
      .filter((block) => afterMessageId === undefined || block.id > afterMessageId)
      .map((block) => ({
        channel: block.channel,
        messageId: block.id,
        messageUrl: `https://t.me/${block.channel}/${block.id}`,
        mints: extractMintCandidates(block.html),
      }));
  }
}
