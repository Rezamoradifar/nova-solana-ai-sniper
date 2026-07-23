export type Dex = 'pumpfun' | 'raydium' | 'orca' | 'jupiter' | 'pumpswap' | 'meteora';

/**
 * Hard ceiling on SnipeConfigs a single user can hold, enforced at every creation
 * path (apps/telegram-bot's Quick Start button and apps/api's POST /snipes route).
 * Confirmed live 2026-07-11: with no cap, repeated taps of "Add Another Config"
 * over one day left a user with 75 duplicate configs, which then made the
 * Telegram sniper_start screen permanently fail with "message is too long" (over
 * Telegram's 4096-char limit) — see renderSniperStart in
 * apps/telegram-bot/src/ui/screens/sniper.ts.
 */
export const MAX_SNIPE_CONFIGS_PER_USER = 5;

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
  // Real DexScreener txns/volume data, from the shortest window with any signal
  // (m5, falling back to h1) — a brand-new token has zero/sparse h1/h24 activity
  // in its first minutes, so those longer windows aren't useful at entry time.
  // Undefined when DexScreener has no pair yet (same as the fields above).
  recentBuys?: number;
  recentSells?: number;
  recentVolumeUsd?: number;
  // Which fallback tier resolved liquidityUsd (see riskAnalyzer.ts's
  // resolveLiquidityUsd) — used by entryFilter.ts to gate on confidence, not
  // just the number itself. Same string values as apps/api's LiquiditySource;
  // duplicated here (not imported) to keep this package app-agnostic.
  liquiditySource?:
    'dexscreener' | 'native_dex' | 'pumpfun_bonding_curve' | 'jupiter_estimate' | 'unavailable';
  // Tri-state tracking (2026-07-22 audit, false-positive gate rejections):
  // mintAuthorityRevoked/freezeAuthorityRevoked/top10HolderPercent/holderCount/
  // isHoneypotSuspected above still fail-closed to their existing worst-case
  // values (false/100/0/true) when the underlying on-chain read couldn't be
  // completed — UNKNOWN must still block a buy, same as before. These three
  // flags exist ONLY so a genuine "we couldn't check" is distinguishable from
  // a genuine "we checked and it's bad" in logs, alerts, and the critical
  // security gate's reason codes — never used to relax the fail-closed
  // booleans themselves. All optional/undefined-by-default so every existing
  // caller/test that doesn't set them is unaffected.
  /** True when the on-chain mint-authority/freeze-authority/supply read itself
   * failed (RPC error, unresolvable account, or an unsupported token program)
   * — mintAuthorityRevoked/freezeAuthorityRevoked are unverified, not
   * confirmed-false, in this case. */
  mintAuthorityDataUnknown?: boolean;
  /** True when holder concentration/count could not be computed — either the
   * mint-authority read it depends on failed (see above) or the
   * largest-accounts read itself failed. top10HolderPercent/holderCount are
   * unverified (100/0 placeholders), not a confirmed critical reading. */
  holderDataUnknown?: boolean;
  /** True when isHoneypotSuspected is true *solely* because an upstream input
   * was unknown (mint authority and/or holder data), not because of a
   * genuinely resolved low-liquidity or high-concentration signal. */
  honeypotCheckUnknown?: boolean;
}

/**
 * Hard Loss Ceiling (2026-07-18): no position is ever allowed a stop loss
 * looser than this — see apps/api/src/trading/exitEngine.ts's
 * resolveEffectiveStopLossPercent (the actual enforcement point) and
 * apps/telegram-bot's settings.ts (surfaces this in the edit prompt so a
 * user isn't surprised their own looser value gets capped at buy time).
 * Lives here, not duplicated in each app, since both need the same number.
 */
export const DEFAULT_MAX_LOSS_PERCENT = 20;

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

export type AiRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** 'BUY'/'SKIP' as suggested by the AI provider — advisory only. AutoTrader's own
 * deterministic gates (entryFilter.ts's mint/freeze/LP/honeypot checks, notifyGate.ts's
 * hard risk gate, and the `Math.min(ruleScore, aiScore)` threshold in autoTrader.ts) are
 * always the final authority and can never be bypassed by this field — see
 * riskScorer.ts's scoreToken, which force-sets this to 'SKIP' whenever a critical risk
 * flag is present, regardless of what the model itself returned. */
export type AiDecision = 'BUY' | 'SKIP';

export interface AiScore {
  score: number; // 0-100, higher = safer/more promising
  riskLevel: AiRiskLevel;
  decision: AiDecision;
  reasons: string[];
  warnings: string[];
  /** Back-compat convenience string derived from reasons+warnings; persisted as Token.aiSummary. */
  summary: string;
  /** Back-compat alias — reasons+warnings combined, same list previous callers read as "flags". */
  flags: string[];
  provider: 'anthropic' | 'openai' | 'gemini' | 'openrouter';
}

export type OrderSide = 'buy' | 'sell';

export interface ExitRule {
  takeProfitPercent?: number;
  stopLossPercent?: number;
  trailingStopPercent?: number;
}

export type MarketingCategory =
  'news' | 'trading_tips' | 'market_updates' | 'trending_tokens' | 'referral' | 'announcements';
