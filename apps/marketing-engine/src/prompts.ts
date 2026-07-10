import type { MarketingCategory } from '@nova/shared';

const CATEGORY_BRIEFS: Record<MarketingCategory, string> = {
  news: 'A short, punchy news-style update about the Solana memecoin/trading ecosystem in general (no fabricated specific events — keep it evergreen: trends, ecosystem growth, sniper-bot relevance).',
  trading_tips:
    'A practical, actionable trading tip for Solana sniping (risk management, slippage, position sizing, spotting rug pulls, using take-profit/stop-loss, etc).',
  market_updates:
    'A general market-sentiment style update relevant to Solana meme/new-token trading (evergreen framing, no fabricated price data).',
  trending_tokens:
    'Guidance on how traders can use the platform to spot trending/new tokens early (feature-focused, not a specific token call — never name a real ticker as if endorsing it).',
  referral:
    'A referral-program promo encouraging users to invite friends and earn rewards through the platform.',
  announcements:
    'A platform announcement about a feature of Nova Solana AI Sniper (auto-buy, AI risk scoring, copy trading, TP/SL/trailing stop, backtesting, dashboard, etc).',
};

const SYSTEM_PROMPT = `You are the marketing copywriter for "Nova Solana AI Sniper", an AI-powered
Solana memecoin sniping platform (auto-buy/sell, AI risk scoring, honeypot detection, copy
trading, TP/SL/trailing stops, backtesting, live dashboard).

Write Telegram-ready marketing copy. Rules:
- Never fabricate specific price data, specific token names/tickers, or specific real events/dates.
- Never give financial advice framed as guaranteed profit; always imply trading crypto is risky.
- Tone: confident, energetic, crypto-native, but not scammy or hype-only.
- Respond with ONLY a JSON object: {"title": "<short title, no emoji spam>", "body": "<2-4 sentences, Telegram Markdown allowed>"}
- No markdown code fences, no extra text outside the JSON object.`;

export function buildPrompt(category: MarketingCategory, avoidHint?: string): string {
  const brief = CATEGORY_BRIEFS[category];
  const avoidLine = avoidHint
    ? `\n\nThe previous attempt was too similar to existing content. Write something meaningfully different: ${avoidHint}`
    : '';
  return `Category: ${category}\nBrief: ${brief}${avoidLine}`;
}

export { SYSTEM_PROMPT };
