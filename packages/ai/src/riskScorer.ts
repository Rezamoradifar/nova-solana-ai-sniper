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
  const prompt = `Token: ${token.symbol ?? token.mint}
Mint: ${token.mint}
DEX: ${token.dex}
Mint authority revoked: ${riskFlags.mintAuthorityRevoked}
Freeze authority revoked: ${riskFlags.freezeAuthorityRevoked}
LP burned/locked: ${riskFlags.lpBurnedOrLocked}
Top 10 holder %: ${riskFlags.top10HolderPercent.toFixed(2)}
Liquidity USD: ${riskFlags.liquidityUsd}
Honeypot suspected (rule-based): ${riskFlags.isHoneypotSuspected}`;

  const raw = await provider.generateText(prompt, { system: SYSTEM_PROMPT, maxTokens: 300 });

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
