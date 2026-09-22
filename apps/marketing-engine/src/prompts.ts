import type { MarketingCategory } from '@nova/shared';

const CATEGORY_BRIEFS: Record<MarketingCategory, string> = {
  news: 'A short, punchy news-style update about the Solana memecoin/trading ecosystem in general (no fabricated specific events — keep it evergreen: trends, ecosystem growth, sniper-bot relevance).',
  trading_tips:
    'A practical, actionable trading tip for Solana sniping (risk management, slippage, position sizing, spotting rug pulls, using take-profit/stop-loss, etc).',
  market_updates:
    'A general market-sentiment style update relevant to Solana meme/new-token trading (evergreen framing unless verified facts are supplied below — never fabricate price data).',
  trending_tokens:
    'Guidance on how traders can use the platform to spot trending/new tokens early (feature-focused, not a specific token call — never name a real ticker as if endorsing it).',
  referral:
    'A referral-program promo encouraging users to invite friends and earn rewards through the platform.',
  announcements:
    'A platform announcement about a feature of GSP Bank Sniper (auto-buy, AI risk scoring, copy trading, TP/SL/trailing stop, backtesting, dashboard, etc).',
};

const SYSTEM_PROMPT = `You are the bilingual marketing copywriter for "GSP Bank Sniper", an
AI-powered Solana memecoin sniping platform (auto-buy/sell, AI risk scoring, honeypot detection,
copy trading, TP/SL/trailing stops, backtesting, live dashboard).

Write Telegram-ready marketing copy in BOTH English and Persian (Farsi) for the same post. The
Persian text must read as natural, professional Persian written by a fluent copywriter — not a
literal machine translation of the English sentence structure.

Hard rules (apply to both languages):
- Never claim or imply guaranteed profits, guaranteed returns, or "risk-free" trading. Always keep
  the framing honest that trading crypto carries real risk.
- Never fabricate specific price data, specific token names/tickers, specific statistics, or
  specific real events/dates. If a "Verified facts you may cite" block is provided below, you may
  cite ONLY the exact numbers given there, worded however you like — never alter them, never add
  any other number, name, or statistic that isn't in that block. If no such block is provided,
  stay evergreen and cite no numbers at all.
- Tone: confident, energetic, crypto-native, but not scammy or hype-only.
- Respond with ONLY a JSON object, no markdown code fences, no extra text outside it:
  {"titleEn": "<short title, no emoji spam>", "bodyEn": "<2-4 sentences>", "titleFa": "<Persian title>", "bodyFa": "<2-4 Persian sentences>"}`;

export interface BuildPromptOptions {
  avoidHint?: string;
  marketFacts?: string;
  /** Narrows a category's brief to a specific angle without needing a new
   * MarketingCategory (e.g. "focus specifically on identifying honeypot
   * tokens" within trading_tips) — not consulted by the automated scheduler
   * today (see runner.ts), but a real, reusable extension point rather than
   * a one-off. */
  topicHint?: string;
}

export function buildPrompt(category: MarketingCategory, options: BuildPromptOptions = {}): string {
  const brief = CATEGORY_BRIEFS[category];
  const topicLine = options.topicHint
    ? `\n\nSpecific angle for this post: ${options.topicHint}`
    : '';
  const avoidLine = options.avoidHint
    ? `\n\nThe previous attempt was too similar to existing content. Write something meaningfully different: ${options.avoidHint}`
    : '';
  const factsLine = options.marketFacts
    ? `\n\nVerified facts you may cite (use only these, do not alter them, do not add others):\n${options.marketFacts}`
    : '';
  return `Category: ${category}\nBrief: ${brief}${topicLine}${factsLine}${avoidLine}`;
}

export { SYSTEM_PROMPT };
