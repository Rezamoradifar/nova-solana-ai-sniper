export type Dex = 'pumpfun' | 'raydium' | 'orca' | 'jupiter' | 'pumpswap' | 'meteora';

export interface TokenInfo {
  mint: string;
  symbol?: string;
  name?: string;
  decimals: number;
  createdAt: string;
  dex: Dex;
  poolAddress?: string;
}

export interface RiskFlags {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpBurnedOrLocked: boolean;
  top10HolderPercent: number;
  isHoneypotSuspected: boolean;
  liquidityUsd: number;
  // Sourced straight from the DexScreener pair RiskAnalyzer already fetches for
  // liquidity — no extra network call. Absent when no pair was found yet (e.g. a
  // brand-new pump.fun bonding-curve token DexScreener hasn't indexed).
  name?: string;
  symbol?: string;
  marketCapUsd?: number;
  // Real DexScreener market data (pair.priceChange), same free-ride as the fields
  // above — not a computed/invented "momentum" formula, just the raw % change
  // DexScreener itself already reports.
  priceChangeH1?: number;
  priceChangeH24?: number;
  // From getHolderConcentration (onchain.ts) — count of non-zero accounts among
  // Solana's top-20-largest-accounts read, not a true total holder count.
  holderCount?: number;
  // DexScreener's own pair.info.imageUrl — the token logo for trade cards.
  imageUrl?: string;
}

/** Optional exit strategy — see apps/api/src/trading/adaptiveTrailingStop.ts. */
export type TrailingStopPreset =
  'conservative' | 'balanced' | 'aggressive' | 'meme_coin' | 'custom';

export const TRAILING_STOP_PRESETS: readonly Exclude<TrailingStopPreset, 'custom'>[] = [
  'conservative',
  'balanced',
  'aggressive',
  'meme_coin',
] as const;

export const TRAILING_STOP_PRESET_LABELS: Record<Exclude<TrailingStopPreset, 'custom'>, string> = {
  conservative: '🛡 Conservative',
  balanced: '⚖️ Balanced',
  aggressive: '🚀 Aggressive',
  meme_coin: '🐸 Meme Coin Mode',
};

export interface AiScore {
  score: number; // 0-100, higher = safer/more promising
  summary: string;
  flags: string[];
  provider: 'anthropic' | 'openai';
}

export type OrderSide = 'buy' | 'sell';

export interface ExitRule {
  takeProfitPercent?: number;
  stopLossPercent?: number;
  trailingStopPercent?: number;
}

export type MarketingCategory =
  'news' | 'trading_tips' | 'market_updates' | 'trending_tokens' | 'referral' | 'announcements';
