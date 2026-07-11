import type { Connection } from '@solana/web3.js';
import type { RiskFlags, Logger } from '@nova/shared';
import type { Dex } from '@prisma/client';
import { getHolderConcentration, getMintAuthorityInfo } from './onchain.js';
import type { DexScreenerClient, DexScreenerPair } from '../solana/dexscreener.js';
import type { JupiterClient } from '../solana/jupiter.js';
import { SOL_MINT } from '../solana/jupiter.js';
import {
  estimateBondingCurveLiquidityUsd,
  getBondingCurveState,
  SolPriceOracle,
} from '../solana/pumpfunBondingCurve.js';
import type { DexRegistry } from '../solana/dex/registry.js';

export interface RiskAnalysisInput {
  mint: string;
  /** Known venue + pool for this token, if already on file — enables the native-DEX liquidity reader as a fallback source. */
  dex?: Dex;
  poolAddress?: string;
}

export type LiquiditySource =
  'dexscreener' | 'native_dex' | 'pumpfun_bonding_curve' | 'jupiter_estimate' | 'unavailable';

export interface LiquidityResolution {
  liquidityUsd: number;
  source: LiquiditySource;
}

/**
 * Picks the best available liquidity figure out of the candidate sources, in
 * confidence order. Pure and independently unit-tested so the fallback priority
 * can't silently regress. DexScreener's own `liquidity` field is absent (not just
 * zero) for pre-migration pump.fun pairs — a present-but-zero value is trusted as
 * real, only an *absent* one triggers fallback. Native DEX reads (PumpSwap/
 * Raydium/Orca/Meteora) rank above the pump.fun bonding curve and Jupiter estimate
 * — they're a direct on-chain reserve read for a pool we already have the address
 * for, not an approximation — but below DexScreener, which aggregates across
 * every pool for a mint rather than just the one pool we happen to know about.
 */
export function resolveLiquidityUsd(candidates: {
  dexScreenerLiquidityUsd: number | undefined;
  nativeDexLiquidityUsd: number | undefined;
  bondingCurveLiquidityUsd: number | undefined;
  jupiterEstimateLiquidityUsd: number | undefined;
}): LiquidityResolution {
  if (candidates.dexScreenerLiquidityUsd !== undefined) {
    return { liquidityUsd: candidates.dexScreenerLiquidityUsd, source: 'dexscreener' };
  }
  if (candidates.nativeDexLiquidityUsd !== undefined) {
    return { liquidityUsd: candidates.nativeDexLiquidityUsd, source: 'native_dex' };
  }
  if (candidates.bondingCurveLiquidityUsd !== undefined) {
    return { liquidityUsd: candidates.bondingCurveLiquidityUsd, source: 'pumpfun_bonding_curve' };
  }
  if (candidates.jupiterEstimateLiquidityUsd !== undefined) {
    return { liquidityUsd: candidates.jupiterEstimateLiquidityUsd, source: 'jupiter_estimate' };
  }
  return { liquidityUsd: 0, source: 'unavailable' };
}

/**
 * Rough constant-product liquidity estimate from a swap quote's price impact:
 * for a small probe trade, impact fraction ~= probeAmount / poolReserve, so
 * poolReserve ~= probeAmount / impact. Doubled to represent both sides of the
 * pool, matching the convention used by the other two sources. Last-resort
 * fallback (least accurate) — only used when neither DexScreener nor the
 * pump.fun bonding curve produced a number.
 */
export function estimateLiquidityFromPriceImpact(
  probeAmountSol: number,
  solPriceUsd: number,
  priceImpactPct: number,
): number | undefined {
  const impactFraction = priceImpactPct / 100;
  if (!Number.isFinite(impactFraction) || impactFraction <= 0.0001) return undefined;
  const probeSideUsd = probeAmountSol * solPriceUsd;
  return (probeSideUsd / impactFraction) * 2;
}

const JUPITER_PROBE_AMOUNT_SOL = 0.5;

/**
 * Rule-based rug/honeypot heuristics, independent of the AI score. This runs
 * fast and cheap so it can gate auto-buy before an AI call is even made.
 */
export class RiskAnalyzer {
  private readonly solPriceOracle = new SolPriceOracle();

  constructor(
    private readonly connection: Connection,
    private readonly dexScreener: DexScreenerClient,
    private readonly jupiter: JupiterClient,
    private readonly logger: Logger,
    /** Optional: enables the native-DEX liquidity reader as a fallback source. */
    private readonly dexRegistry?: DexRegistry,
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
      this.dexScreener.getBestSolanaPair(input.mint).catch((err: unknown) => {
        this.logger.debug({ mint: input.mint, err }, 'dexscreener lookup failed');
        return undefined;
      }),
    ]);

    this.logger.debug({ mint: input.mint, dexScreenerPair: pair }, 'raw dexscreener response');

    const { liquidityUsd, source } = await this.resolveLiquidity(
      input.mint,
      pair,
      input.dex,
      input.poolAddress,
    );

    this.logger.info(
      { mint: input.mint, liquidityUsd, source },
      'resolved liquidity for detected token',
    );

    // LP burn/lock can't be derived from DexScreener alone; treat unknown liquidity
    // (no usable source at all) as not-yet-safe rather than assuming the best case.
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
      name: pair?.baseToken?.name,
      symbol: pair?.baseToken?.symbol,
      marketCapUsd: pair?.marketCap,
      priceChangeH1: pair?.priceChange?.h1,
      priceChangeH24: pair?.priceChange?.h24,
    };
  }

  /** DexScreener -> native DEX reader -> on-chain pump.fun bonding curve -> Jupiter price-impact estimate -> 0. */
  private async resolveLiquidity(
    mint: string,
    pair: DexScreenerPair | undefined,
    dex: Dex | undefined,
    poolAddress: string | undefined,
  ): Promise<LiquidityResolution> {
    const dexScreenerLiquidityUsd = pair?.liquidity?.usd;
    if (dexScreenerLiquidityUsd !== undefined) {
      return resolveLiquidityUsd({
        dexScreenerLiquidityUsd,
        nativeDexLiquidityUsd: undefined,
        bondingCurveLiquidityUsd: undefined,
        jupiterEstimateLiquidityUsd: undefined,
      });
    }

    const nativeDexLiquidityUsd = await this.tryNativeDexLiquidity(mint, dex, poolAddress);
    if (nativeDexLiquidityUsd !== undefined) {
      return resolveLiquidityUsd({
        dexScreenerLiquidityUsd: undefined,
        nativeDexLiquidityUsd,
        bondingCurveLiquidityUsd: undefined,
        jupiterEstimateLiquidityUsd: undefined,
      });
    }

    const bondingCurveLiquidityUsd = await this.tryBondingCurveLiquidity(mint);
    if (bondingCurveLiquidityUsd !== undefined) {
      return resolveLiquidityUsd({
        dexScreenerLiquidityUsd: undefined,
        nativeDexLiquidityUsd: undefined,
        bondingCurveLiquidityUsd,
        jupiterEstimateLiquidityUsd: undefined,
      });
    }

    const jupiterEstimateLiquidityUsd = await this.tryJupiterLiquidityEstimate(mint);
    return resolveLiquidityUsd({
      dexScreenerLiquidityUsd: undefined,
      nativeDexLiquidityUsd: undefined,
      bondingCurveLiquidityUsd: undefined,
      jupiterEstimateLiquidityUsd,
    });
  }

  private async tryNativeDexLiquidity(
    mint: string,
    dex: Dex | undefined,
    poolAddress: string | undefined,
  ): Promise<number | undefined> {
    if (!this.dexRegistry || !dex || !poolAddress) return undefined;
    try {
      const pool = await this.dexRegistry.getLiquidity(dex, poolAddress);
      this.logger.debug({ mint, dex, poolAddress, pool }, 'raw native DEX pool response');
      return pool?.liquidityUsd;
    } catch (err) {
      this.logger.debug({ mint, dex, poolAddress, err }, 'native DEX liquidity lookup failed');
      return undefined;
    }
  }

  private async tryBondingCurveLiquidity(mint: string): Promise<number | undefined> {
    try {
      const [state, solPriceUsd] = await Promise.all([
        getBondingCurveState(this.connection, mint),
        this.solPriceOracle.getPriceUsd(this.dexScreener),
      ]);
      this.logger.debug(
        { mint, bondingCurveState: state, solPriceUsd },
        'raw pump.fun bonding curve response',
      );
      if (!state || solPriceUsd === undefined) return undefined;
      return estimateBondingCurveLiquidityUsd(state, solPriceUsd);
    } catch (err) {
      this.logger.debug({ mint, err }, 'pump.fun bonding curve lookup failed');
      return undefined;
    }
  }

  private async tryJupiterLiquidityEstimate(mint: string): Promise<number | undefined> {
    try {
      const [quote, solPriceUsd] = await Promise.all([
        this.jupiter.getQuote({
          inputMint: SOL_MINT,
          outputMint: mint,
          amountLamports: BigInt(Math.round(JUPITER_PROBE_AMOUNT_SOL * 1e9)),
          slippageBps: 500,
        }),
        this.solPriceOracle.getPriceUsd(this.dexScreener),
      ]);
      this.logger.debug({ mint, jupiterQuote: quote, solPriceUsd }, 'raw jupiter quote response');
      if (solPriceUsd === undefined) return undefined;
      const priceImpactPct = Number(quote.priceImpactPct);
      if (!Number.isFinite(priceImpactPct)) return undefined;
      return estimateLiquidityFromPriceImpact(
        JUPITER_PROBE_AMOUNT_SOL,
        solPriceUsd,
        priceImpactPct,
      );
    } catch (err) {
      this.logger.debug(
        { mint, err },
        'jupiter quote-based liquidity estimate failed (likely no route yet)',
      );
      return undefined;
    }
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
