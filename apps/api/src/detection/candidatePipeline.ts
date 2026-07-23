import type { PrismaClient } from '@prisma/client';
import type { Logger, RiskFlags } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';
import type { RiskAnalyzer, LaunchableDex } from './riskAnalyzer.js';
import {
  classifySecurityState,
  evaluateCriticalSecurityGate,
} from '../trading/criticalSecurityGate.js';
import { checkSellability, isTransientQuoteError } from '../trading/sellabilityCheck.js';
import type { JupiterClient } from '../solana/jupiter.js';
import { SOL_MINT } from '../solana/jupiter.js';
import { TtlCache } from '../lib/ttlCache.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Telegram rejection-alert dedupe (2026-07-22 audit): before this, every
 * single candidatePipeline rejection sent a Telegram alert, even for a mint
 * that had already been reported minutes (or seconds) ago with the exact
 * same reasons — a launch that keeps getting re-evaluated (repeated WS
 * events, a retried queue item) spammed the same "BUY CANCELLED" message
 * over and over. Keyed on mint + the exact sorted reason set, so a genuine
 * state change (e.g. holder data resolving from unknown to a real number, or
 * liquidity source flipping to dexscreener) is a different key and still
 * alerts — only a truly repeated, unchanged verdict is suppressed.
 */
const REJECTION_ALERT_DEDUP_TTL_MS = 30 * 60 * 1000;
const rejectionAlertCache = new TtlCache<string>(REJECTION_ALERT_DEDUP_TTL_MS);

/** Test-only: clears the dedup cache so tests never leak state into each
 * other — same convention as resilientConnection.ts's counter/cooldown
 * registries. */
export function resetRejectionAlertDedupCache(): void {
  rejectionAlertCache.clear();
}

function rejectionAlertKey(mint: string, reasons: string[]): string {
  return `${mint}|${[...reasons].sort().join(',')}`;
}

/** Fire-and-forget, deduped — never awaited by a caller that needs the alert
 * to have been sent; a Telegram send stalling must never delay pipeline
 * throughput. */
function notifyRejectionOnce(
  notifier: NotificationService | undefined,
  mint: string,
  reasons: string[],
  message: string,
  title: string,
): void {
  const key = rejectionAlertKey(mint, reasons);
  if (rejectionAlertCache.has(key)) return;
  rejectionAlertCache.add(key);
  void notifier?.notifyError(title, message);
}

/** Same representative trade size the old autoTrader.ts pre-check used — see
 * its original doc comment: checked once per token, before any per-config
 * buyAmountSol is known. */
const SELLABILITY_CHECK_NOTIONAL_SOL = 0.1;

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

  const [riskFlagsResult, deployerBlacklistResult, forwardQuoteResult] = await Promise.allSettled([
    deps.riskAnalyzer.analyze({
      mint: candidate.mint,
      dex: candidate.dex,
      poolAddress: candidate.poolAddress,
    }),
    candidate.deployerAddress === undefined
      ? Promise.resolve(undefined)
      : deps.prisma.blacklistEntry.findUnique({
          where: { type_value: { type: 'DEPLOYER', value: candidate.deployerAddress } },
        }),
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
      `BUY CANCELLED — CRITICAL SECURITY GATE\nReasons:\n${reasons.join(', ')}`,
    );
    notifyRejectionOnce(
      deps.notifier,
      candidate.mint,
      reasons,
      `Auto-buy blocked for ${candidate.mint}: ${reasons.join(', ')}`,
      'critical security gate',
    );
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
      `BUY CANCELLED — PRE-BUY SELLABILITY CHECK\nReason:\n${forwardReason}`,
    );
    notifyRejectionOnce(
      deps.notifier,
      candidate.mint,
      [forwardReason],
      `Auto-buy blocked for ${candidate.mint}: ${forwardReason}`,
      'pre-buy sellability check',
    );
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
      `BUY CANCELLED — PRE-BUY SELLABILITY CHECK\nReason:\n${sellability.reason}`,
    );
    notifyRejectionOnce(
      deps.notifier,
      candidate.mint,
      [sellability.reason ?? 'no_sell_route'],
      `Auto-buy blocked for ${candidate.mint}: ${sellability.reason}`,
      'pre-buy sellability check',
    );
    return {
      passed: false,
      reasons: [sellability.reason ?? 'no_sell_route'],
      riskFlags,
      timestamps: { analysisStartedAt, dexValidatedAt, safetyCompletedAt, sellabilityVerifiedAt },
    };
  }

  return {
    passed: true,
    riskFlags,
    sellabilityTokenAmountRaw,
    timestamps: { analysisStartedAt, dexValidatedAt, safetyCompletedAt, sellabilityVerifiedAt },
  };
}
