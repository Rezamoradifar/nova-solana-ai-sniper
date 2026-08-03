import type { Logger } from '@nova/shared';
import type { JupiterClient } from '../solana/jupiter.js';
import { SOL_MINT } from '../solana/jupiter.js';

/**
 * Pre-buy sell-route verification (2026-07-21 audit, section D): two live
 * positions ("ㅤ", "Zca") were bought despite already being effectively
 * unsellable — both isHoneypotSuspected, both single/two-holder tokens, and
 * both have zero live DexScreener pairs or Jupiter routes today. Nothing in
 * the buy pipeline ever checked whether a sell would even be possible before
 * committing real SOL. This is a read-only reverse-quote check (mint→SOL) —
 * never a real trade — run for the exact amount the buy is about to acquire.
 */

/** Above this, the position is nominally sellable but at a cost that makes the
 * trade unattractive before it's even opened — conservative enough to allow
 * normal meme-coin volatility while still catching a token where almost the
 * entire notional would be lost to impact alone. */
export const MAX_ACCEPTABLE_EXIT_PRICE_IMPACT_PCT = 25;

/** Short, bounded retry for a transient (network/rate-limit/server-error)
 * quote failure — distinct from a genuine "no route exists" response, which
 * is never retried (retrying won't manufacture a route that isn't there). */
const TRANSIENT_ERROR_MAX_ATTEMPTS = 3;
const TRANSIENT_ERROR_RETRY_DELAY_MS = 300;

/** Matches a failed-request error (HTTP 429/5xx, timeout, network-level
 * failure) — same convention as resilientConnection.ts's RETRYABLE_PATTERNS,
 * duplicated here rather than imported to keep this a plain Jupiter-HTTP
 * concern, unrelated to the Solana RPC failover pool. */
const TRANSIENT_ERROR_PATTERNS = [
  '429',
  'too many requests',
  'rate limit',
  '500',
  '502',
  '503',
  '504',
  'timeout',
  'timed out',
  'econnreset',
  'econnrefused',
  'etimedout',
  'fetch failed',
  'socket hang up',
  'network error',
  'aborterror',
];

/**
 * Production incident (2026-07-22 audit, false-positive gate rejections):
 * checkSellability's catch block previously treated *any* thrown error —
 * including a Jupiter API timeout, rate limit, or 5xx — identically to a
 * confirmed "no route exists," reporting both as `no_sell_route`. A failed
 * HTTP request is not evidence the token can't be sold; it's evidence the
 * check itself didn't complete. Jupiter's actual "no route" response is an
 * HTTP 4xx (not 429) with no retryable pattern in the body — everything
 * matching TRANSIENT_ERROR_PATTERNS is a failed *request*, not a resolved
 * *answer*, and is retried a bounded number of times before this function
 * gives up and reports it as unknown (`sellability_check_failed`) rather
 * than a confirmed rejection.
 */
export function isTransientQuoteError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((p) => message.includes(p));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SellabilityResult {
  sellable: boolean;
  reason?: 'no_sell_route' | 'exit_price_impact_too_high' | 'sellability_check_failed';
  priceImpactPct?: number;
}

/** Distinct from SafetyCheckError (money/limits) so a catch block can report
 * a clean 'not_sellable' reason instead of the generic 'execution_error'
 * bucket. checkSellability() itself (below) is called once per token from
 * candidatePipeline.ts's runCandidatePipeline, which reports failure via a
 * plain return value, not by throwing this — this class exists for
 * AutoTrader's per-config catch block, kept as defensive/forward-compatible
 * handling in case a future caller (e.g. positionManager.ts) ever throws it. */
export class SellabilityCheckError extends Error {
  constructor(
    public readonly reasonCode: SellabilityResult['reason'],
    public readonly priceImpactPct?: number,
  ) {
    super(`token failed pre-buy sellability check: ${reasonCode}`);
    this.name = 'SellabilityCheckError';
  }
}

/**
 * `estimatedTokenAmountRaw` is the raw (undecimalized) token amount the BUY
 * quote says this trade would acquire — reverse-quoting exactly that amount
 * makes this a faithful "could I actually exit this specific trade" check,
 * not a check against some unrelated nominal size.
 */
export async function checkSellability(
  jupiter: JupiterClient,
  mint: string,
  estimatedTokenAmountRaw: bigint,
  logger: Logger,
): Promise<SellabilityResult> {
  if (estimatedTokenAmountRaw <= 0n) {
    return { sellable: false, reason: 'no_sell_route' };
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_ERROR_MAX_ATTEMPTS; attempt++) {
    try {
      const reverseQuote = await jupiter.getQuote({
        inputMint: mint,
        outputMint: SOL_MINT,
        amountLamports: estimatedTokenAmountRaw,
        slippageBps: 1000,
      });
      // Jupiter reports priceImpactPct as a fraction (0.0057 = 0.57%), not a
      // whole percent — normalized here so callers/logs/thresholds all deal in
      // actual percent, matching MAX_ACCEPTABLE_EXIT_PRICE_IMPACT_PCT's unit.
      const rawImpact = Number(reverseQuote.priceImpactPct);
      const priceImpactPct = Number.isFinite(rawImpact) ? rawImpact * 100 : undefined;
      if (priceImpactPct !== undefined && priceImpactPct > MAX_ACCEPTABLE_EXIT_PRICE_IMPACT_PCT) {
        return { sellable: false, reason: 'exit_price_impact_too_high', priceImpactPct };
      }
      return { sellable: true, priceImpactPct };
    } catch (err) {
      lastErr = err;
      if (!isTransientQuoteError(err)) {
        // A genuine, resolved "no route" answer (or any other non-transient
        // failure) — retrying won't change the answer.
        logger.debug({ mint, err }, 'pre-buy sellability check: no reverse route found');
        return { sellable: false, reason: 'no_sell_route' };
      }
      if (attempt < TRANSIENT_ERROR_MAX_ATTEMPTS) {
        logger.debug(
          { mint, err, attempt },
          'pre-buy sellability check: transient request failure, retrying',
        );
        await sleep(TRANSIENT_ERROR_RETRY_DELAY_MS);
      }
    }
  }

  // Every attempt failed with a transient (request-level) error — this is a
  // genuine unknown, not a confirmed "can't sell". Still blocks the buy (the
  // caller treats any non-sellable result as a reject), but must never be
  // logged/alerted as a confirmed rejection reason.
  logger.warn(
    { mint, err: lastErr },
    'pre-buy sellability check: request failed after retries — UNKNOWN, blocking as a precaution (not a confirmed no-route)',
  );
  return { sellable: false, reason: 'sellability_check_failed' };
}
