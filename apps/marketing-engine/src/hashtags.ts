import type { MarketingCategory } from '@nova/shared';

/** Always the last hashtag on every post — non-negotiable brand presence,
 * counted inside the 5-10 total (not added on top of it). */
export const BRANDED_HASHTAG = '#NovaSolanaAI';

/** General/broad hashtags relevant across every category — the "wide net"
 * half of the broad-vs-niche mix. */
const BROAD_HASHTAGS = ['#Solana', '#SOL', '#Crypto', '#CryptoTrading', '#Web3', '#DeFi'];

/** Category-specific/niche hashtags — the "targeted" half of the mix. */
const CATEGORY_HASHTAGS: Record<MarketingCategory, string[]> = {
  news: ['#SolanaNews', '#CryptoNews', '#SolanaEcosystem'],
  trading_tips: ['#TradingTips', '#AITrading', '#SolanaTrading', '#TokenScanner'],
  market_updates: ['#MarketUpdate', '#SolanaTrading', '#CryptoMarket', '#SOLPrice'],
  trending_tokens: ['#TrendingTokens', '#SolanaMemecoin', '#Memecoin', '#NewTokens'],
  referral: ['#ReferralProgram', '#PassiveIncome', '#CryptoRewards'],
  announcements: ['#Announcement', '#ProductUpdate', '#SolanaEcosystem'],
};

/** Prioritized (guaranteed-first) tags for security-flavored content —
 * detected from the generated copy itself (see isSecurityTopic), since the
 * automated scheduler doesn't pass an explicit topic/sub-genre today (see
 * imagePolicy.ts's own doc comment on the same limitation for visuals). */
const SECURITY_PRIORITY_HASHTAGS = ['#CryptoSecurity', '#ScamAlert', '#Honeypot'];

/** Prioritized tags for trending-token content, per product requirement. */
const TRENDING_PRIORITY_HASHTAGS = ['#Solana', '#TrendingTokens', '#SolanaMemecoin'];

const SECURITY_KEYWORDS = [
  'honeypot',
  'scam',
  'rug pull',
  'rugpull',
  'malicious',
  'exploit',
  'phishing',
  'drain',
  'hacked',
];

/** Best-effort content classification from the AI-generated English copy —
 * cheap keyword scan, not a hard taxonomy. False negatives just mean the
 * post gets category-default hashtags instead of the security-priority set,
 * never a crash or an empty hashtag line. */
function isSecurityTopic(titleEn: string, bodyEn: string): boolean {
  const text = `${titleEn} ${bodyEn}`.toLowerCase();
  return SECURITY_KEYWORDS.some((keyword) => text.includes(keyword));
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = temp;
  }
  return copy;
}

const MIN_HASHTAGS = 5;
const MAX_HASHTAGS = 10;

export interface HashtagInput {
  category: MarketingCategory;
  titleEn: string;
  bodyEn: string;
}

/**
 * Picks 5-10 relevant hashtags for a post: a mix of broad (Solana/crypto)
 * and category-niche tags, security- or trending-priority tags guaranteed
 * first when applicable, and the branded tag always last. The total count
 * and the fill order are both randomized (via `random`) so consecutive
 * posts don't converge on an identical set — see hashtags.test.ts.
 */
export function selectHashtags(input: HashtagInput, random: () => number = Math.random): string[] {
  const priorityTags = isSecurityTopic(input.titleEn, input.bodyEn)
    ? SECURITY_PRIORITY_HASHTAGS
    : input.category === 'trending_tokens'
      ? TRENDING_PRIORITY_HASHTAGS
      : [];

  const pool = [
    ...new Set([...priorityTags, ...CATEGORY_HASHTAGS[input.category], ...BROAD_HASHTAGS]),
  ].filter((tag) => tag !== BRANDED_HASHTAG);

  // Total includes the always-appended branded tag, so the pool only needs
  // to supply MIN_HASHTAGS-1 .. MAX_HASHTAGS-1 of the budget. Clamped
  // defensively in case `random` is seeded with exactly 1 (Math.random()
  // itself never returns 1, but a test/caller-supplied generator might).
  const targetTotal = Math.min(
    MAX_HASHTAGS,
    MIN_HASHTAGS + Math.floor(random() * (MAX_HASHTAGS - MIN_HASHTAGS + 1)),
  );
  const poolBudget = Math.max(0, Math.min(pool.length, targetTotal - 1));

  const guaranteedPriority = priorityTags
    .filter((tag) => tag !== BRANDED_HASHTAG)
    .slice(0, poolBudget);
  const rest = shuffle(
    pool.filter((tag) => !guaranteedPriority.includes(tag)),
    random,
  ).slice(0, poolBudget - guaranteedPriority.length);

  return [...guaranteedPriority, ...rest, BRANDED_HASHTAG];
}
