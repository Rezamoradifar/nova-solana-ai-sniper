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
}

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
