import { PublicKey } from '@solana/web3.js';
import { SOL_MINT } from '../solana/jupiter.js';

const BASE58_ADDR = '[1-9A-HJ-NP-Za-km-z]{32,44}';

/**
 * Link patterns these trend channels actually use to reference "this is the
 * token" (verified against live t.me/s/trendingssol and t.me/s/trending
 * markup) — a `solscan.io/token/<addr>` or `jup.ag/swap/SOL-<addr>` link is
 * unambiguously the mint. Deliberately NOT matching `solscan.io/address/`
 * (the buyer's wallet in these messages, confirmed against real posts) or
 * `solscan.io/tx/` (the swap signature) or `dextools.io/.../pair-explorer/`
 * (the pool address, not the mint) — including those would extract "valid
 * Solana addresses" that are not mints, which the source instructions
 * explicitly rule out.
 */
const MINT_LINK_PATTERNS: RegExp[] = [
  new RegExp(`dexscreener\\.com/solana/(${BASE58_ADDR})`, 'gi'),
  new RegExp(`solscan\\.io/token/(${BASE58_ADDR})`, 'gi'),
  new RegExp(`pump\\.fun/coin/(${BASE58_ADDR})`, 'gi'),
  new RegExp(`birdeye\\.so/token/(${BASE58_ADDR})`, 'gi'),
  new RegExp(`jup\\.ag/swap/SOL-(${BASE58_ADDR})`, 'gi'),
];

/** Fallback for channels/messages that just paste a bare contract address rather than a link. */
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

/**
 * Pure extraction over one message's raw HTML fragment (not stripped text —
 * the mint lives in href attributes, not the anchor's often-truncated
 * display text like "3ACp4T...aFdW"). Case is preserved exactly as posted:
 * base58 is case-sensitive, so normalizing case would risk silently pointing
 * at a different account. A candidate that turns out not to be a real mint
 * (e.g. a mis-cased or unrelated address) is not dangerous downstream — the
 * cheap liquidity precheck (see riskAnalyzer.ts) simply finds no liquidity
 * for it and rejects it, the same as any other junk candidate.
 */
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

export interface TelegramSignalMessage {
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

/**
 * Splits the channel preview page into per-message HTML fragments by finding
 * each `data-post="<channel>/<id>"` marker and slicing up to the next one —
 * avoids a regex lookahead loop over ~200KB of HTML (backtracking risk) in
 * favor of a single linear scan.
 */
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
 * credentials. Only works for public channels with a username, which both
 * configured channels are. Best-effort: Telegram's HTML markup here is
 * external and unversioned, so this may need updating if they change it.
 */
export class TelegramTrendClient {
  async fetchMessages(channel: string, afterMessageId?: number): Promise<TelegramSignalMessage[]> {
    const res = await fetch(`https://t.me/s/${encodeURIComponent(channel)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NovaSniperBot/1.0)' },
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
