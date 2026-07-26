import type { PrismaClient } from '@prisma/client';
import type { Logger, RiskFlags } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';
import type { RiskAnalyzer, LaunchableDex } from './riskAnalyzer.js';
import {
  classifySecurityState,
  evaluateCriticalSecurityGate,
} from '../trading/criticalSecurityGate.js';
import { checkSellability, isTransientQuoteError } from '../trading/sellabilityCheck.js';
import { checkMintBlacklist } from '../trading/mintBlacklist.js';
import type { JupiterClient } from '../solana/jupiter.js';
import { SOL_MINT } from '../solana/jupiter.js';
import { securityGateStats } from './securityGateStats.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Section 8 audit (2026-07-23, "excessive Telegram alerts" incident): before
 * this, every unique (mint, reason-set) rejection sent an individual
 * Telegram alert (deduped only by a 30-minute TTL, not suppressed outright) —
 * with real production traffic that's still a constant stream of "🚨 Error in
 * critical security gate" pings for completely normal gate behavior (a token
 * correctly not being bought), not a system error. Every rejection is now
 * recorded into securityGateStats instead — a periodic 15-minute summary
 * (securityGateSummaryReporter.ts) reports the aggregate to Telegram; nothing
 * here sends an individual message anymore. `notifier` is no longer used by
 * this module at all, but stays part of CandidatePipelineDeps unchanged
 * (worker.ts still passes it; a future genuinely-immediate alert here would
 * need it).
 */
function recordRejection(reasons: string[]): void {
  securityGateStats.recordBlocked(reasons);
}

/** Same representative trade size the old autoTrader.ts pre-check used — see
 * its original doc comment: checked once per token, before any per-config
 * buyAmountSol is known. */
const SELLABILITY_CHECK_NOTIONAL_SOL = 0.1;

/**
 * Production incident (2026-07-23 audit): a brand-new pump.fun launch has no
 * DexScreener listing yet (indexing lags the on-chain create by anywhere from
 * a few seconds to a couple of minutes) and its mint/holder-concentration
 * on-chain reads can transiently fail against the very fastest RPC read this
 * bot's own detection speed produces — both correctly fail this gate closed
 * (never assumed safe), but treating that first failure as final rejected
 * *every* fresh launch, not just genuinely bad ones: confirmed live, zero
 * buys for a full day while every individual check kept working exactly as
 * designed. This set is exactly the reasons that mean "couldn't verify yet"
 * (an UNKNOWN state, or a request-level failure) rather than "verified bad" —
 * see criticalSecurityGate.ts's own SAFE/UNSAFE/UNKNOWN breakdown, which this
 * mirrors.
 */
const DATA_UNAVAILABLE_REJECTION_REASONS = new Set([
  'dexscreener_validation_failed',
  'holder_data_unknown',
  'mint_authority_unknown',
  'freeze_authority_unknown',
  'honeypot_check_unknown',
  'risk_analysis_failed',
  'deployer_check_failed',
  'mint_check_failed',
  'sellability_check_failed',
]);

/**
 * Follow-up audit (2026-07-23, "excessive rejections" incident): a 22-hour
 * production log sample showed 189 distinct rejected mints, 92% of them
 * failing `dexscreener_validation_failed` and 91.5% `honeypot_suspected` —
 * and of the 15 that *did* enter the (then 60-second) retry window above,
 * zero ever resolved to a pass. Cross-referencing riskFlags on those
 * rejections: `holder_concentration_critical`/`holder_count_critical` fire
 * because a token seconds old genuinely has almost no holders yet (the
 * on-chain reading is real, not unknown), and `honeypot_suspected` very
 * commonly fires purely because bonding-curve liquidity hasn't accumulated
 * past the $500 floor yet (riskAnalyzer.ts's isHoneypotSuspected) — both are
 * real, resolved readings of a token that is simply too young to have
 * revealed itself, not confirmed fraud. `lp_not_locked_or_burned` is the same
 * story at zero liquidity. None of these are removed as gate criteria and
 * none of their thresholds change — a token that still fails them once it's
 * had real time to trade is rejected for good, exactly as before. Retrying
 * them is provably safe, not a weakening: the full pipeline (including this
 * exact gate) always re-runs before any buy, so nothing new is ever accepted
 * that wouldn't have passed anyway — the only thing that changes is how long
 * we wait, on a token that hasn't yet had the chance to prove itself either
 * way, before giving up. `mint_authority_not_revoked`/
 * `freeze_authority_not_revoked` (the *confirmed*, non-`_unknown` variants),
 * `deployer_blacklisted`, `mint_blacklisted`, `no_sell_route`, and every
 * holder-clustering reason are deliberately EXCLUDED — those describe a
 * structural property that time alone does not change, so they keep
 * rejecting for good on the very first attempt.
 */
const AGE_DEPENDENT_REJECTION_REASONS = new Set([
  'holder_concentration_critical',
  'holder_count_critical',
  'honeypot_suspected',
  'lp_not_locked_or_burned',
]);

const RETRYABLE_REJECTION_REASONS = new Set([
  ...DATA_UNAVAILABLE_REJECTION_REASONS,
  ...AGE_DEPENDENT_REJECTION_REASONS,
]);

/** Empty `reasons` (nothing rejected) is not "retryable" — there's nothing to
 * retry. Mixed in with even one confirmed-bad reason, the whole rejection is
 * treated as final, same as the gate's own all-or-nothing `allowed` verdict. */
export function isRetryableRejection(reasons: string[]): boolean {
  return reasons.length > 0 && reasons.every((r) => RETRYABLE_REJECTION_REASONS.has(r));
}

export interface CandidatePipelineDeps {
  riskAnalyzer: RiskAnalyzer;
  jupiter: JupiterClient;
  prisma: PrismaClient;
  logger: Logger;
  notifier?: NotificationService;
}

export interface CandidateInput {
  mint: string;
  dex: LaunchableDex;
  poolAddress?: string;
  /**
   * Fee payer of the token's creation transaction — undefined for sources
   * with no creation tx to pull it from (e.g. the Telegram-trend source,
   * which only ever sees a bare mint mentioned in a channel). Absence is NOT
   * treated as "unknown, so skip": a blacklist is a deny-list membership
   * check, not a token-risk signal, so "no identity to check" is the same as
   * "not on the list" — pass-through, exactly like the existing MINT
   * blacklist check's own absence-of-match semantics. This is deliberately
   * narrower than every other check in this pipeline, which DOES fail closed
   * on missing data (those describe the token's own risk; this doesn't).
   */
  deployerAddress?: string;
}

export interface CandidatePipelineTimestamps {
  analysisStartedAt: number;
  dexValidatedAt: number;
  safetyCompletedAt: number;
  sellabilityVerifiedAt?: number;
}

export type CandidatePipelineResult =
  | {
      passed: true;
      riskFlags: RiskFlags;
      /** Raw (undecimalized) token amount the sellability forward-quote says
       * this notional buy would acquire — available for a caller that wants
       * to avoid re-quoting, though nothing currently needs it downstream. */
      sellabilityTokenAmountRaw: bigint;
      timestamps: Required<CandidatePipelineTimestamps>;
    }
  | {
      passed: false;
      reasons: string[];
      /** Present whenever riskAnalyzer.analyze() itself succeeded (i.e. a
       * later gate is what failed) — lets a caller still upsert a Token row
       * with real metadata for a rejected candidate, preserving the existing
       * mint-dedupe guarantee (a re-delivered WS event for the same rejected
       * mint should be skipped, not re-run the full pipeline). Absent only
       * when analyze() itself threw. */
      riskFlags?: RiskFlags;
      timestamps: CandidatePipelineTimestamps;
    };

/**
 * Two-stage discovery pipeline (2026-07-22): the single place every mandatory,
 * fail-closed, per-token deterministic check runs — DexScreener/liquidity/
 * on-chain-authority/holder-concentration (riskAnalyzer.analyze), creator/
 * deployer blacklist, and TOKEN<->SOL sellability — before the AI provider is
 * ever called. Previously these ran serially, split across worker.ts (before
 * the AI call) and autoTrader.ts (after it) — meaning the AI provider got
 * called, and paid for, on tokens that would later fail this exact gate. Runs
 * once per token (not once per user/config), same as before.
 *
 * Independent checks run concurrently (`Promise.allSettled`): risk analysis,
 * the deployer-blacklist lookup, and the sellability forward quote (SOL->mint)
 * don't depend on each other's results. The sellability *reverse* quote
 * (mint->SOL, via checkSellability) does depend on the forward quote's output
 * amount, and is skipped entirely once the critical gate or deployer check
 * already failed — no reason to spend a second network call confirming a
 * doomed token can't be sold either.
 */
export async function runCandidatePipeline(
  deps: CandidatePipelineDeps,
  candidate: CandidateInput,
): Promise<CandidatePipelineResult> {
  const analysisStartedAt = Date.now();

  const [riskFlagsResult, deployerBlacklistResult, mintBlacklistResult, forwardQuoteResult] =
    await Promise.allSettled([
      deps.riskAnalyzer.analyze({
        mint: candidate.mint,
        dex: candidate.dex,
        poolAddress: candidate.poolAddress,
        deployerAddress: candidate.deployerAddress,
      }),
      candidate.deployerAddress === undefined
        ? Promise.resolve(undefined)
        : deps.prisma.blacklistEntry.findUnique({
            where: { type_value: { type: 'DEPLOYER', value: candidate.deployerAddress } },
          }),
      // Blacklist consistency fix (2026-07-23 USOH incident follow-up): this
      // mint check previously only ran inline in worker.ts's
      // handleTelegramSignal — an on-chain-detected candidate reaching this
      // pipeline directly (runCandidateThroughPipeline) never checked the
      // MINT blacklist at all, so a MINT entry added during incident response
      // only blocked re-processing via Telegram, not on-chain detection.
      // Both paths now go through checkMintBlacklist, so this is a single
      // source of truth regardless of discovery source.
      checkMintBlacklist(deps.prisma, candidate.mint),
      deps.jupiter.getQuote({
        inputMint: SOL_MINT,
        outputMint: candidate.mint,
        amountLamports: BigInt(Math.floor(SELLABILITY_CHECK_NOTIONAL_SOL * LAMPORTS_PER_SOL)),
        slippageBps: 300,
      }),
    ]);

  const dexValidatedAt = Date.now();

  if (riskFlagsResult.status === 'rejected') {
    deps.logger.warn(
      { mint: candidate.mint, err: riskFlagsResult.reason },
      'candidatePipeline: risk analysis threw — failing closed, never treated as a false pass',
    );
    return {
      passed: false,
      reasons: ['risk_analysis_failed'],
      timestamps: { analysisStartedAt, dexValidatedAt, safetyCompletedAt: dexValidatedAt },
    };
  }
  const riskFlags = riskFlagsResult.value;

  const criticalGate = evaluateCriticalSecurityGate(riskFlags);
  const reasons = [...criticalGate.reasons];

  if (mintBlacklistResult.status === 'rejected') {
    deps.logger.warn(
      { mint: candidate.mint, err: mintBlacklistResult.reason },
      'candidatePipeline: mint blacklist lookup failed — failing closed',
    );
    reasons.push('mint_check_failed');
  } else if (mintBlacklistResult.value.blacklisted) {
    reasons.push('mint_blacklisted');
  }

  if (candidate.deployerAddress !== undefined) {
    if (deployerBlacklistResult.status === 'rejected') {
      // A failed lookup (not "no match") is a genuine unknown for a check we
      // were actually able to attempt — fails closed, unlike an address that
      // was never available at all (see CandidateInput's doc comment).
      deps.logger.warn(
        {
          mint: candidate.mint,
          deployerAddress: candidate.deployerAddress,
          err: deployerBlacklistResult.reason,
        },
        'candidatePipeline: deployer blacklist lookup failed — failing closed',
      );
      reasons.push('deployer_check_failed');
    } else if (deployerBlacklistResult.value) {
      reasons.push('deployer_blacklisted');
    }
  }

  const safetyCompletedAt = Date.now();

  if (reasons.length > 0) {
    // SAFE/UNSAFE/UNKNOWN breakdown (2026-07-22 audit): the combined `reasons`
    // list above already distinguishes confirmed-bad from unknown per reason
    // string (see criticalSecurityGate.ts), but this per-criterion table is
    // what makes a "was this a real scam or did a data source fail?" question
    // answerable directly from the log line, without re-deriving it from the
    // raw riskFlags every time.
    deps.logger.warn(
      {
        mint: candidate.mint,
        reasons,
        riskFlags,
        securityState: classifySecurityState(riskFlags),
        location:
          'apps/api/src/detection/candidatePipeline.ts:runCandidatePipeline (critical security gate)',
      },
      `SECURITY GATE BLOCKED CANDIDATE\nReasons:\n${reasons.join(', ')}`,
    );
    recordRejection(reasons);
    return {
      passed: false,
      reasons,
      riskFlags,
      timestamps: { analysisStartedAt, dexValidatedAt, safetyCompletedAt },
    };
  }

  if (forwardQuoteResult.status === 'rejected') {
    // Same distinction as checkSellability's own reverse-quote handling: a
    // failed *request* (rate limit, timeout, 5xx) is not evidence the token
    // has no buy route — only a genuinely resolved "no route" answer is.
    const forwardReason = isTransientQuoteError(forwardQuoteResult.reason)
      ? 'sellability_check_failed'
      : 'no_sell_route';
    deps.logger.warn(
      {
        mint: candidate.mint,
        reasonCode: forwardReason,
        err: forwardQuoteResult.reason,
        location:
          'apps/api/src/detection/candidatePipeline.ts:runCandidatePipeline (sellability check)',
      },
      `SECURITY GATE BLOCKED CANDIDATE — PRE-BUY SELLABILITY CHECK\nReason:\n${forwardReason}`,
    );
    recordRejection([forwardReason]);
    return {
      passed: false,
      reasons: [forwardReason],
      riskFlags,
      timestamps: { analysisStartedAt, dexValidatedAt, safetyCompletedAt },
    };
  }

  const sellabilityTokenAmountRaw = BigInt(forwardQuoteResult.value.outAmount);
  const sellability = await checkSellability(
    deps.jupiter,
    candidate.mint,
    sellabilityTokenAmountRaw,
    deps.logger,
  );
  const sellabilityVerifiedAt = Date.now();

  if (!sellability.sellable) {
    deps.logger.warn(
      {
        mint: candidate.mint,
        reasonCode: sellability.reason,
        priceImpactPct: sellability.priceImpactPct,
        location:
          'apps/api/src/detection/candidatePipeline.ts:runCandidatePipeline (sellability check)',
      },
      `SECURITY GATE BLOCKED CANDIDATE — PRE-BUY SELLABILITY CHECK\nReason:\n${sellability.reason}`,
    );
    recordRejection([sellability.reason ?? 'no_sell_route']);
    return {
      passed: false,
      reasons: [sellability.reason ?? 'no_sell_route'],
      riskFlags,
      timestamps: { analysisStartedAt, dexValidatedAt, safetyCompletedAt, sellabilityVerifiedAt },
    };
  }

  securityGateStats.recordPassed();
  return {
    passed: true,
    riskFlags,
    sellabilityTokenAmountRaw,
    timestamps: { analysisStartedAt, dexValidatedAt, safetyCompletedAt, sellabilityVerifiedAt },
  };
}
