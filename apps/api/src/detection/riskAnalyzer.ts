import type { Connection } from '@solana/web3.js';
import type { RiskFlags } from '@nova/shared';
import { getHolderConcentration, getMintAuthorityInfo } from './onchain.js';
import type { DexScreenerClient } from '../solana/dexscreener.js';

export interface RiskAnalysisInput {
  mint: string;
}

/**
 * Rule-based rug/honeypot heuristics, independent of the AI score. This runs
 * fast and cheap so it can gate auto-buy before an AI call is even made.
 */
export class RiskAnalyzer {
  constructor(
    private readonly connection: Connection,
    private readonly dexScreener: DexScreenerClient,
  ) {}

  async analyze(input: RiskAnalysisInput): Promise<RiskFlags> {
    const [mintAuthority, holders, pair] = await Promise.all([
      getMintAuthorityInfo(this.connection, input.mint).catch(() => ({
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        decimals: 9,
        supply: 0n,
      })),
      getHolderConcentration(this.connection, input.mint).catch(() => ({
        top10HolderPercent: 100,
        holderCount: 0,
      })),
      this.dexScreener.getBestSolanaPair(input.mint).catch(() => undefined),
    ]);

    const liquidityUsd = pair?.liquidity?.usd ?? 0;

    // LP burn/lock can't be derived from DexScreener alone; treat unknown liquidity
    // (no pair found yet) as not-yet-safe rather than assuming the best case.
    const lpBurnedOrLocked = liquidityUsd > 0;

    const isHoneypotSuspected =
      !mintAuthority.mintAuthorityRevoked || holders.top10HolderPercent > 70 || liquidityUsd < 500;

    return {
      mintAuthorityRevoked: mintAuthority.mintAuthorityRevoked,
      freezeAuthorityRevoked: mintAuthority.freezeAuthorityRevoked,
      lpBurnedOrLocked,
      top10HolderPercent: holders.top10HolderPercent,
      isHoneypotSuspected,
      liquidityUsd,
    };
  }

  /** Simple 0-100 composite score derived purely from rule-based flags (no AI). */
  static ruleBasedScore(flags: RiskFlags): number {
    let score = 100;
    if (!flags.mintAuthorityRevoked) score -= 35;
    if (!flags.freezeAuthorityRevoked) score -= 15;
    if (!flags.lpBurnedOrLocked) score -= 20;
    if (flags.top10HolderPercent > 50) score -= 20;
    else if (flags.top10HolderPercent > 30) score -= 10;
    if (flags.liquidityUsd < 1000) score -= 15;
    if (flags.isHoneypotSuspected) score -= 20;
    return Math.max(0, Math.min(100, score));
  }
}
