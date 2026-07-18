import { Connection, PublicKey } from '@solana/web3.js';
import type { RiskFlags, Logger } from '@nova/shared';
import type { Dex } from '@prisma/client';
import { getHolderConcentration, getMintAuthorityInfo } from './onchain.js';
import type { DexScreenerClient, DexScreenerPair } from '../solana/dexscreener.js';
import type { JupiterClient } from '../solana/jupiter.js';
import { SOL_MINT } from '../solana/jupiter.js';
import {
  estimateBondingCurveLiquidityUsd,
  getBondingCurveState,
  getBondingCurveVaultAta,
  sharedSolPriceOracle,
  type SolPriceOracle,
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

/** Every Dex value a token can actually launch/trade on — excludes JUPITER,
 * which is an aggregator route label, never a launch venue itself. */
export type LaunchableDex = Exclude<Dex, 'JUPITER'>;

/**
 * Maps DexScreener's own `dexId` string to this codebase's `Dex` enum,
 * matching only the venues the DEX filter actually supports (PumpSwap,
 * pump.fun, Raydium, Orca, Meteora) — anything else (an unlisted/fake pool,
 * or DexScreener not indexing it under a name we recognize) returns
 * `undefined`, which callers treat as "ignore this pool." Pure and exported
 * so the mapping can't silently regress, same convention as
 * resolveLiquidityUsd.
 */
export function mapDexScreenerIdToDex(dexId: string | undefined): LaunchableDex | undefined {
  if (!dexId) return undefined;
  const id = dexId.toLowerCase();
  if (id.includes('pumpswap')) return 'PUMPSWAP';
  if (id.includes('pumpfun') || id.includes('pump.fun')) return 'PUMPFUN';
  if (id.includes('raydium')) return 'RAYDIUM';
  if (id.includes('orca')) return 'ORCA';
  if (id.includes('meteora')) return 'METEORA';
  return undefined;
}

export interface CheapLiquidityResult {
  liquidityUsd: number;
  dex?: LaunchableDex;
  poolAddress?: string;
}

export interface RecentActivity {
  recentBuys?: number;
  recentSells?: number;
  recentVolumeUsd?: number;
}

/**
 * Picks the shortest DexScreener txns/volume window that actually has any
 * activity (m5, falling back to h1) — a brand-new token's h1/h24 windows are
 * sparse or all-zero in its first few minutes, so they're not a useful entry
 * signal; m5 is, when it has anything in it at all. Pure and independently
 * tested so this fallback can't silently regress, same pattern as
 * resolveLiquidityUsd.
 */
export function resolveRecentActivity(pair: DexScreenerPair | undefined): RecentActivity {
  if (!pair) return {};
  const m5 = pair.txns?.m5;
  const m5HasActivity = (m5?.buys ?? 0) + (m5?.sells ?? 0) > 0;
  const window = m5HasActivity ? m5 : pair.txns?.h1;
  const volumeUsd = m5HasActivity ? pair.volume?.m5 : pair.volume?.h1;
  return {
    recentBuys: window?.buys,
    recentSells: window?.sells,
    recentVolumeUsd: volumeUsd,
  };
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

/** A launch is sometimes reported by more than one detection source in quick
 * succession (e.g. a pump.fun `create` log plus a near-simultaneous DEX
 * pool-creation event for the same mint) — this dedupes the full ~7-10-call
 * analysis for the same (mint, dex, poolAddress) tuple within the window. */
const RISK_RESULT_TTL_MS = 60_000;
/** Lazily swept once the cache grows past this size, rather than on a timer. */
const RISK_RESULT_CACHE_SWEEP_THRESHOLD = 2000;

/**
 * Rule-based rug/honeypot heuristics, independent of the AI score. This runs
 * fast and cheap so it can gate auto-buy before an AI call is even made.
 */
export class RiskAnalyzer {
  private readonly solPriceOracle: SolPriceOracle = sharedSolPriceOracle;
  private readonly resultCache = new Map<string, { result: RiskFlags; expiresAt: number }>();

  constructor(
    private readonly connection: Connection,
    private readonly dexScreener: DexScreenerClient,
    private readonly jupiter: JupiterClient,
    private readonly logger: Logger,
    /** Optional: enables the native-DEX liquidity reader as a fallback source. */
    private readonly dexRegistry?: DexRegistry,
  ) {}

  /**
   * bypassCache, if true, skips both the cache read and write — for a caller
   * that specifically needs a fresh on-chain read every call (e.g.
   * EmergencyExitMonitor, which would otherwise see whatever an unrelated
   * AutoBuy/Discovery call cached for this same mint up to 60s ago).
   * Optional and undefined by default so every existing single-arg caller
   * keeps its exact current cached behavior.
   */
  async analyze(input: RiskAnalysisInput, opts?: { bypassCache?: boolean }): Promise<RiskFlags> {
    const cacheKey = `${input.mint}|${input.dex ?? ''}|${input.poolAddress ?? ''}`;
    if (!opts?.bypassCache) {
      const cached = this.resultCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.result;
    }

    const result = await this.analyzeUncached(input);

    if (!opts?.bypassCache) {
      if (this.resultCache.size >= RISK_RESULT_CACHE_SWEEP_THRESHOLD) {
        const now = Date.now();
        for (const [key, entry] of this.resultCache) {
          if (entry.expiresAt <= now) this.resultCache.delete(key);
        }
      }
      this.resultCache.set(cacheKey, { result, expiresAt: Date.now() + RISK_RESULT_TTL_MS });
    }

    return result;
  }

  /**
   * A liquidity-only check, far cheaper than analyze(): one HTTP call to
   * DexScreener and, only if that has nothing, one cheap `getAccountInfo`
   * RPC read of the pump.fun bonding curve — no mint-authority or
   * holder-concentration RPC calls. Meant to sit in front of untrusted/noisy
   * candidate sources (e.g. the Telegram trend monitor) so junk never
   * reaches the expensive part of analyze() or an AI call. Returns
   * `liquidityUsd: 0` (no `dex`) for anything with no liquidity on a
   * recognized venue, which the caller treats as an immediate reject.
   */
  async cheapLiquidityPrecheck(mint: string): Promise<CheapLiquidityResult> {
    const pair = await this.dexScreener.getBestSolanaPair(mint).catch((err: unknown) => {
      this.logger.debug({ mint, err }, 'cheap liquidity precheck: dexscreener lookup failed');
      return undefined;
    });

    if (pair?.liquidity?.usd !== undefined) {
      const dex = mapDexScreenerIdToDex(pair.dexId);
      return dex
        ? { liquidityUsd: pair.liquidity.usd, dex, poolAddress: pair.pairAddress }
        : { liquidityUsd: 0 };
    }

    const bondingCurveLiquidityUsd = await this.tryBondingCurveLiquidity(mint);
    if (bondingCurveLiquidityUsd !== undefined && bondingCurveLiquidityUsd > 0) {
      return { liquidityUsd: bondingCurveLiquidityUsd, dex: 'PUMPFUN' };
    }

    return { liquidityUsd: 0 };
  }

  private async analyzeUncached(input: RiskAnalysisInput): Promise<RiskFlags> {
    const excludeAddresses = await this.resolveExcludedVaultAddresses(
      input.mint,
      input.dex,
      input.poolAddress,
    );

    // mintAuthority is resolved first (not in the Promise.all below) because its
    // `supply` field is exactly the total-supply figure getHolderConcentration
    // needs — threading it through means holders no longer issues its own
    // redundant getTokenSupply RPC call for the same mint account. Net effect:
    // same critical-path latency as before (holders' own getTokenLargestAccounts
    // call already ran after its getTokenSupply call, sequentially, so this just
    // reorders which sequential pair runs first) but one fewer RPC call overall.
    let mintAuthorityFetchFailed = false;
    const mintAuthority = await getMintAuthorityInfo(this.connection, input.mint).catch(() => {
      mintAuthorityFetchFailed = true;
      return {
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        decimals: 9,
        supply: 0n,
      };
    });

    // If mintAuthority itself failed to fetch, its 0n supply fallback is not a
    // real total supply — computing holder concentration against it would read
    // as "0% concentrated" (looks safe) rather than "unknown" (should look
    // risky), inverting the fail-conservative fallback below. Skip the call
    // entirely in that case rather than let it run on bogus input.
    const [holders, pair] = await Promise.all([
      mintAuthorityFetchFailed
        ? Promise.resolve({ top10HolderPercent: 100, holderCount: 0 })
        : getHolderConcentration(
            this.connection,
            input.mint,
            mintAuthority.supply,
            excludeAddresses,
          ).catch(() => ({
            top10HolderPercent: 100,
            holderCount: 0,
          })),
      this.dexScreener.getBestSolanaPair(input.mint).catch((err: unknown) => {
        this.logger.debug({ mint: input.mint, err }, 'dexscreener lookup failed');
        return undefined;
      }),
    ]);

    this.logger.debug({ mint: input.mint, dexScreenerPair: pair }, 'raw dexscreener response');

    // A token that's already disqualified by the cheap, always-fetched checks
    // above (mint/freeze authority not revoked, or wallet-concentration already
    // past the honeypot line) will be isHoneypotSuspected regardless of exactly
    // what liquidity figure resolves — so it's not worth spending a live Jupiter
    // quote (tryJupiterLiquidityEstimate, the most expensive fallback tier) just
    // to refine a number nobody will act on differently. See resolveLiquidity's
    // `skipJupiterEstimate` param.
    const cheapSignalsAlreadyDisqualify =
      !mintAuthority.mintAuthorityRevoked || holders.top10HolderPercent > 70;

    const { liquidityUsd, source } = await this.resolveLiquidity(
      input.mint,
      pair,
      input.dex,
      input.poolAddress,
      cheapSignalsAlreadyDisqualify,
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

    const recentActivity = resolveRecentActivity(pair);

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
      holderCount: holders.holderCount,
      imageUrl: pair?.info?.imageUrl,
      liquiditySource: source,
      ...recentActivity,
    };
  }

  /** DexScreener -> native DEX reader -> on-chain pump.fun bonding curve -> Jupiter price-impact estimate -> 0. */
  private async resolveLiquidity(
    mint: string,
    pair: DexScreenerPair | undefined,
    dex: Dex | undefined,
    poolAddress: string | undefined,
    skipJupiterEstimate: boolean,
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

    const jupiterEstimateLiquidityUsd = skipJupiterEstimate
      ? undefined
      : await this.tryJupiterLiquidityEstimate(mint);
    return resolveLiquidityUsd({
      dexScreenerLiquidityUsd: undefined,
      nativeDexLiquidityUsd: undefined,
      bondingCurveLiquidityUsd: undefined,
      jupiterEstimateLiquidityUsd,
    });
  }

  /**
   * Addresses to exclude from holder-concentration ranking — the bonding curve's
   * own vault (always, cheap to derive, no RPC call) plus the native AMM pool's
   * vaults when we already know the pool (post-migration or DEX-registry-detected
   * launch). See onchain.ts's getHolderConcentration doc comment.
   */
  private async resolveExcludedVaultAddresses(
    mint: string,
    dex: Dex | undefined,
    poolAddress: string | undefined,
  ): Promise<string[]> {
    const addresses: string[] = [];

    try {
      addresses.push(getBondingCurveVaultAta(new PublicKey(mint)).toBase58());
    } catch (err) {
      this.logger.debug({ mint, err }, 'bonding curve vault derivation failed');
    }

    if (this.dexRegistry && dex && poolAddress) {
      try {
        addresses.push(...(await this.dexRegistry.getVaultAddresses(dex, poolAddress)));
      } catch (err) {
        this.logger.debug({ mint, dex, poolAddress, err }, 'native DEX vault lookup failed');
      }
    }

    return addresses;
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
