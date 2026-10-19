import type { MarketToken } from '../lib/publicMarket.js';

export type Language = 'en' | 'fa';
export const PRODUCTS = [
  { id: 'trade', path: '/trade', icon: 'swap', en: 'DEX Trading', fa: 'معامله غیرمتمرکز', sub: 'A smarter way to swap.', subFa: 'تبادل با دیدی روشن‌تر.', tag: 'RESEARCH' },
  { id: 'exchange', path: '/exchange', icon: 'chart', en: 'Pro Exchange', fa: 'صرافی حرفه‌ای', sub: 'Precision. At every price.', subFa: 'دقت در هر سفارش.', tag: 'PAPER' },
  { id: 'copy', path: '/copy', icon: 'copy', en: 'Copy Trading', fa: 'کپی ترید', sub: 'Learn from a different edge.', subFa: 'استراتژی‌ها را مقایسه کن.', tag: 'PREVIEW' },
  { id: 'opportunities', path: '/opportunities', icon: 'arbitrage', en: 'Arbitrage', fa: 'آربیتراژ', sub: 'Find the space between markets.', subFa: 'اختلاف قیمت بازارها را پیدا کن.', tag: 'RESEARCH' },
  { id: 'meme-hub', path: '/meme-hub', icon: 'spark', en: 'Meme Coin Hub', fa: 'مرکز میم‌کوین', sub: 'Early signals. Clearer risks.', subFa: 'سیگنال زودهنگام، ریسک روشن.', tag: 'PREVIEW' },
  { id: 'flash-loans', path: '/flash-loans', icon: 'bolt', en: 'Flash Loans', fa: 'وام آنی', sub: 'Build it. Model it. Understand it.', subFa: 'بساز، مدل کن و ارزیابی کن.', tag: 'SANDBOX' },
  { id: 'bots', path: '/bots', icon: 'bot', en: 'Trading Bots', fa: 'ربات‌های معامله‌گر', sub: 'Your strategy, systematically.', subFa: 'استراتژی تو، به‌صورت منظم.', tag: 'PAPER' },
  { id: 'portfolio', path: '/portfolio', icon: 'wallet', en: 'Portfolio', fa: 'سبد دارایی', sub: 'Your whole picture.', subFa: 'تصویر کامل دارایی‌هایت.', tag: 'PREVIEW' },
] as const;
export type ProductId = typeof PRODUCTS[number]['id'];
export const CHAINS = ['Solana', 'Ethereum', 'BSC', 'Arbitrum', 'Base'] as const;
export type Chain = typeof CHAINS[number];

// Deterministic DESIGN FIXTURES. Render only when the visitor explicitly enables ?demo=1.
export const DEMO_MARKETS: MarketToken[] = [
  ['SOL', 'Solana', 148.32, 5.24, 184600000, 96400000, '#8B5CF6'],
  ['ETH', 'Ethereum', 3248.76, 2.87, 846200000, 426000000, '#8095ff'],
  ['BTC', 'Bitcoin', 67482.35, 1.62, 2145000000, 960000000, '#F7931A'],
  ['JUP', 'Jupiter', .8426, 8.45, 28360000, 18300000, '#b0d964'],
  ['BONK', 'Bonk', .00002654, 12.68, 15420000, 9450000, '#F7A531'],
  ['WIF', 'dogwifhat', 2.1834, -3.24, 8720000, 6840000, '#c79aca'],
].map(([symbol, name, price, change, volume, liquidity, color]) => ({ symbol: String(symbol), name: String(name), mint: 'demo-' + symbol, price: Number(price), change: Number(change), volume: Number(volume), liquidity: Number(liquidity), color: String(color), pairs: [], priceUpdatedAt: 0 }));

export const TRADERS = [
  { id: 'quant-wolf', name: 'QuantWolf', initials: 'QW', color: '#00E5FF', style: 'Quantitative', fa: 'کمی', roi: 84.62, win: 71.4, drawdown: 12.8, followers: 1248, risk: 'Medium', riskFa: 'متوسط', seed: 2 },
  { id: 'sol-sage', name: 'SolSage', initials: 'SS', color: '#8B5CF6', style: 'Swing trader', fa: 'نوسان‌گیری', roi: 62.38, win: 76.2, drawdown: 8.4, followers: 964, risk: 'Low', riskFa: 'کم', seed: 5 },
  { id: 'delta-zero', name: 'DeltaZero', initials: 'DZ', color: '#F5B956', style: 'Arbitrage', fa: 'آربیتراژ', roi: 48.91, win: 82.5, drawdown: 5.2, followers: 836, risk: 'Low', riskFa: 'کم', seed: 9 },
  { id: 'neon-alpha', name: 'NeonAlpha', initials: 'NA', color: '#ec91d3', style: 'Momentum', fa: 'مومنتوم', roi: 112.46, win: 64.8, drawdown: 23.6, followers: 721, risk: 'High', riskFa: 'زیاد', seed: 14 },
];
export type Trader = typeof TRADERS[number];
export const OPPORTUNITIES = [
  { pair: 'SOL / USDC', a: 'Raydium', b: 'Orca', spread: .84, cost: 1.12, latency: 240 },
  { pair: 'JUP / USDC', a: 'Meteora', b: 'Raydium', spread: .62, cost: 1.46, latency: 318 },
  { pair: 'BONK / SOL', a: 'Orca', b: 'Meteora', spread: .43, cost: 1.08, latency: 286 },
  { pair: 'RAY / USDC', a: 'Raydium', b: 'Orca', spread: .31, cost: 1.32, latency: 364 },
];
export const MEMES = [
  { symbol: 'BONK', name: 'Bonk', icon: 'B', color: '#F7A531', cap: '1.82B', holders: '742.8K', liquidity: '$9.45M', h1: 2.42, h24: 12.68, score: 82, dev: 2.1 },
  { symbol: 'WIF', name: 'dogwifhat', icon: 'W', color: '#c79aca', cap: '2.18B', holders: '188.4K', liquidity: '$6.84M', h1: -1.28, h24: -3.24, score: 74, dev: 3.4 },
  { symbol: 'MOON', name: 'Moon Cat', icon: 'M', color: '#00E5FF', cap: '8.42M', holders: '2.4K', liquidity: '$482K', h1: 14.82, h24: 68.24, score: 46, dev: 11.7 },
  { symbol: 'FROG', name: 'Frog Terminal', icon: 'F', color: '#22C55E', cap: '4.16M', holders: '1.8K', liquidity: '$218K', h1: 8.64, h24: 42.17, score: 35, dev: 18.2 },
];
export const BOT_TYPES = [
  { name: 'Grid', fa: 'گرید', icon: 'grid', desc: 'Give sideways markets a plan.', descFa: 'برنامه‌ای برای بازارهای رنج.', color: '#00E5FF' },
  { name: 'DCA', fa: 'خرید پله‌ای', icon: 'layers', desc: 'Build a position, one step at a time.', descFa: 'ساخت پوزیشن به‌صورت مرحله‌ای.', color: '#8B5CF6' },
  { name: 'Arbitrage', fa: 'آربیتراژ', icon: 'arbitrage', desc: 'Observe opportunities across venues.', descFa: 'پایش فرصت‌ها بین بازارها.', color: '#22C55E' },
  { name: 'Sniper', fa: 'اسنایپر', icon: 'target', desc: 'Model entries with strict risk limits.', descFa: 'مدل‌سازی ورود با سقف ریسک.', color: '#F5B956' },
  { name: 'Market Maker', fa: 'بازارساز', icon: 'chart', desc: 'Explore two-sided quoting strategies.', descFa: 'بررسی استراتژی سفارش دوطرفه.', color: '#ec91d3' },
];
export function finitePositive(value: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const n = Number(value); return Number.isFinite(n) && n > 0 && n <= 1e9 ? n : null;
}
export function routeEstimate(amount: number, spread: number, gas: number, feeBps = 0) {
  return amount * spread / 100 - gas - amount * feeBps / 10000;
}
export function dollars(value: number, compact = false) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: compact ? 'compact' : 'standard', maximumFractionDigits: value < .01 ? 8 : 2 }).format(value);
}
export function percent(value: number | null | undefined) {
  return value == null ? '—' : (value >= 0 ? '+' : '') + value.toFixed(2) + '%';
}
