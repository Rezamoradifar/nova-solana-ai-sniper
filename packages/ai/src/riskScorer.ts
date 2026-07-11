import type { AiProvider } from './provider.js';
import type { AiScore, RiskFlags, TokenInfo } from '@nova/shared';

const SYSTEM_PROMPT = `You are a Solana token risk analyst embedded in an automated trading system.
Given on-chain risk flags and token metadata, respond with ONLY a JSON object:
{"score": <0-100 integer, higher = safer>, "summary": "<one sentence>", "flags": ["<short flag>", ...]}
Do not include markdown fences or any other text.`;

export async function scoreToken(
  provider: AiProvider,
  token: TokenInfo,
  riskFlags: RiskFlags,
): Promise<AiScore> {
  // Every field below was already computed by RiskAnalyzer for other purposes
  // (liquidity resolution, trade cards, entryFilter.ts) and simply wasn't being
  // shown to the model before — no new data collection, just a fuller prompt.
  const prompt = `Token: ${token.symbol ?? token.mint}
Mint: ${token.mint}
DEX (current venue, migrated off pump.fun if not "pumpfun"): ${token.dex}
Mint authority revoked: ${riskFlags.mintAuthorityRevoked}
Freeze authority revoked: ${riskFlags.freezeAuthorityRevoked}
LP burned/locked: ${riskFlags.lpBurnedOrLocked}
Top 10 holder %: ${riskFlags.top10HolderPercent.toFixed(2)}
Holder count (top-20 accounts sampled, not a true total): ${riskFlags.holderCount ?? 'unknown'}
Liquidity USD: ${riskFlags.liquidityUsd} (confidence: ${riskFlags.liquiditySource ?? 'unknown'})
Honeypot suspected (rule-based): ${riskFlags.isHoneypotSuspected}
Price change 1h/24h: ${riskFlags.priceChangeH1 ?? 'unknown'}% / ${riskFlags.priceChangeH24 ?? 'unknown'}%
Recent buys/sells (shortest window with activity): ${riskFlags.recentBuys ?? 'unknown'} / ${riskFlags.recentSells ?? 'unknown'}
Recent volume USD: ${riskFlags.recentVolumeUsd ?? 'unknown'}`;

  // A provider failure (timeout, rate limit, auth/API error) must fail closed to
  // score 0 just like an unparseable response below, never throw uncaught. This
  // was previously unguarded — only JSON.parse had a try/catch — so a provider-
  // level error unwound straight out of scoreToken and aborted the entire calling
  // handleNewTokenLaunch pipeline: no token notification, no auto-buy evaluation,
  // nothing — a launch was silently dropped instead of degrading gracefully.
  // Kept as its own try/catch (distinct from the parse one below) so the flag/
  // summary still tells the two failure modes apart in logs/DB.
  let raw: string;
  try {
    raw = await provider.generateText(prompt, { system: SYSTEM_PROMPT, maxTokens: 300 });
  } catch {
    return {
      score: 0,
      summary: 'AI scoring failed (provider error); treat as high risk until re-checked.',
      flags: ['ai_call_error'],
      provider: provider.name,
    };
  }

  try {
    const parsed = JSON.parse(raw) as { score: number; summary: string; flags: string[] };
    return {
      score: Math.max(0, Math.min(100, parsed.score)),
      summary: parsed.summary,
      flags: parsed.flags ?? [],
      provider: provider.name,
    };
  } catch {
    return {
      score: 0,
      summary: 'AI response could not be parsed; treat as high risk until re-checked.',
      flags: ['ai_parse_error'],
      provider: provider.name,
    };
  }
}
