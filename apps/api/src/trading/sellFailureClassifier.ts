/**
 * Production Bug Fix (2026-07-14): the SELL execution path had no failure
 * taxonomy at all — every rejected swap surfaced as an opaque `Error` with a
 * provider-specific message, caught, and either silently written to
 * `recordFailedTrade` (no message stored) or logged under a generic
 * "price check failed for open position" line shared with unrelated
 * DexScreener price-fetch failures (see priceMonitor.ts's tick catch). That
 * made it impossible to answer "why do SELLs fail" from production logs
 * without re-reading every stack trace by hand.
 *
 * This module is pure and side-effect free by design — it only pattern-matches
 * on the shape/message of an already-thrown error, so it's exhaustively unit
 * testable without touching the DB, an RPC connection, or Jupiter. Nothing
 * here decides *whether* to exit a position (that remains exitEngine.ts's
 * job) — only how to explain and react to a swap that already failed to send.
 */

export type SellFailureCategory =
  | 'slippage'
  | 'liquidity'
  | 'route_unavailable'
  | 'rpc_timeout'
  | 'blockhash_expired'
  | 'priority_fee_too_low'
  | 'simulation_failed'
  | 'token_account_issue'
  | 'ata_issue'
  | 'position_lock'
  | 'jupiter_failure'
  | 'confirmation_timeout'
  | 'other';

export interface SellFailureClassification {
  category: SellFailureCategory;
  /**
   * True only for failures that are certain (or near-certain) to have never
   * reached the network / never landed on-chain — the one precondition under
   * which resubmitting a fresh swap cannot produce a double-sell. Anything
   * ambiguous (a broadcast that may or may not have landed) must classify as
   * non-retryable here even if the underlying cause is "transient," and
   * instead go through the existing unverifiedSwapLocks reconciliation path.
   */
  retryablePreBroadcast: boolean;
  /** Short human-readable explanation, safe to put directly in a log line. */
  detail: string;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Ordered pattern match — first match wins, so more specific patterns are
 * listed before broader ones (e.g. "blockhash" before a generic RPC-timeout
 * check, since a blockhash rejection often also mentions "failed").
 */
export function classifySellFailure(err: unknown): SellFailureClassification {
  const msg = messageOf(err).toLowerCase();

  // Position-level coordination failures — these never reach Jupiter/RPC at
  // all, so they're trivially "pre-broadcast," but retrying immediately would
  // just re-trip the same lock. Not retryable by this module; the caller
  // (PriceMonitor's next tick) is the correct retry mechanism.
  if (
    msg.includes('already being closed') ||
    msg.includes('already-executed') ||
    msg.includes('concurrent close') ||
    msg.includes('positioncloselock') ||
    msg.includes('landed on-chain but could not be verified')
  ) {
    return {
      category: 'position_lock',
      retryablePreBroadcast: false,
      detail: 'position close/partial-sell lock or unverified-swap reconciliation lock is active',
    };
  }

  if (
    msg.includes('wallet holds 0 of this token') ||
    msg.includes('0 sellable tokens') ||
    msg.includes('tokenaccountnotfound') ||
    msg.includes('could not find account')
  ) {
    return {
      category: 'token_account_issue',
      retryablePreBroadcast: false,
      detail: 'wallet has no on-chain balance / token account for this mint',
    };
  }

  if (
    msg.includes('associated token account') ||
    msg.includes(' ata ') ||
    msg.includes('ata)') ||
    msg.includes('ata,') ||
    msg.startsWith('ata ') ||
    msg.includes('associatedtokenaccount')
  ) {
    return {
      category: 'ata_issue',
      retryablePreBroadcast: false,
      detail: 'associated token account resolution/creation failed',
    };
  }

  if (
    msg.includes('blockhash not found') ||
    msg.includes('block height exceeded') ||
    msg.includes('blockhashnotfound') ||
    msg.includes('blockhash expired')
  ) {
    // A blockhash-not-found rejection is returned synchronously by the RPC
    // node before the transaction is ever accepted into a block — it is the
    // one broadcast-adjacent failure mode where "never landed" is guaranteed,
    // not just likely. Safe to retry with a fresh quote/blockhash.
    return {
      category: 'blockhash_expired',
      retryablePreBroadcast: true,
      detail: 'transaction blockhash expired before it could be included in a block',
    };
  }

  if (
    msg.includes('slippage tolerance exceeded') ||
    msg.includes('slippage exceeded') ||
    msg.includes('exceeds desired slippage limit') ||
    msg.includes('0x1771') // Jupiter/Raydium common slippage-exceeded anchor error code
  ) {
    return {
      category: 'slippage',
      retryablePreBroadcast: false,
      detail: 'price moved past the configured slippage tolerance',
    };
  }

  if (
    msg.includes('no route') ||
    msg.includes('could not find any route') ||
    msg.includes('route not found') ||
    msg.includes('unsupported transaction type')
  ) {
    return {
      category: 'route_unavailable',
      retryablePreBroadcast: false,
      detail: 'no swap route available from Jupiter (or native fallback) for this pair/size',
    };
  }

  if (
    msg.includes('liquidity') ||
    msg.includes('pool has no depth') ||
    msg.includes('computed buy quote is zero') ||
    msg.includes('computed sell quote is zero')
  ) {
    return {
      category: 'liquidity',
      retryablePreBroadcast: false,
      detail: 'insufficient on-chain liquidity to fill this size',
    };
  }

  if (msg.includes('simulation failed') || msg.includes('simulatetransaction')) {
    return {
      category: 'simulation_failed',
      retryablePreBroadcast: false,
      detail: 'pre-flight transaction simulation rejected the swap',
    };
  }

  if (msg.includes('priority fee') || msg.includes('prioritization fee')) {
    return {
      category: 'priority_fee_too_low',
      retryablePreBroadcast: false,
      detail: 'priority fee too low for the transaction to be included in time',
    };
  }

  if (msg.includes('reverted on-chain') || msg.includes('instructionerror')) {
    // Landed and reverted — definitely broadcast, never safe to resubmit blindly.
    return {
      category: 'other',
      retryablePreBroadcast: false,
      detail: 'transaction landed on-chain but reverted',
    };
  }

  if (
    msg.includes('confirmtransaction') ||
    msg.includes('transaction was not confirmed') ||
    msg.includes('confirmation timeout') ||
    (msg.includes('timeout') && msg.includes('confirm'))
  ) {
    return {
      category: 'confirmation_timeout',
      retryablePreBroadcast: false,
      detail:
        'transaction broadcast but confirmation could not be observed in time (ambiguous landing)',
    };
  }

  if (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('abort') ||
    (msg.includes('timeout') && !msg.includes('confirm'))
  ) {
    return {
      category: 'rpc_timeout',
      retryablePreBroadcast: true,
      detail: 'transient RPC/network failure before the transaction was broadcast',
    };
  }

  if (
    msg.includes('jupiter quote failed') ||
    msg.includes('jupiter swap build failed') ||
    msg.includes('jupiter')
  ) {
    // A 5xx/malformed-response from Jupiter that didn't match a more specific
    // pattern above (route/liquidity/slippage) — most commonly a transient
    // upstream error, so pre-broadcast retry is reasonable.
    return {
      category: 'jupiter_failure',
      retryablePreBroadcast: true,
      detail: 'Jupiter quote/swap-build API returned an error',
    };
  }

  return {
    category: 'other',
    retryablePreBroadcast: false,
    detail: msg || 'unclassified failure',
  };
}
