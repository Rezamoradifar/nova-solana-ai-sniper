import { SOL_MINT } from '../solana/jupiter.js';

export interface TokenBalanceLike {
  mint: string;
}

export interface ParsedTxLike {
  meta?: {
    preTokenBalances?: TokenBalanceLike[] | null;
    postTokenBalances?: TokenBalanceLike[] | null;
  } | null;
}

// Wrapped SOL can legitimately show up as a "new" token balance in a create tx
// (e.g. a freshly-created wSOL account used internally for routing/fees) without
// ever being the token that was actually launched — SOL already exists, a pump.fun
// `create` can't mint more of it. Verified live: this resolved a real detection to
// SOL_MINT, which then made AutoTrader try to auto-buy SOL with SOL and fail on
// Jupiter's own "circular arbitrage" guard.
const NEVER_THE_LAUNCHED_MINT = new Set([SOL_MINT]);

/**
 * Resolves the newly-created mint out of a pump.fun `create` transaction.
 *
 * Previously this took `accountKeys[1]` on the theory that the mint is "the 2nd
 * account key by convention" — true only for the simplest possible create tx.
 * Verified against live mainnet transactions: the moment a create is bundled with
 * a dev-buy, routed through Jito, or wrapped by any router/aggregator, the global
 * account-key ordering shifts (Solana orders the static account list by
 * signer/writable status, not by per-instruction position) and index 1 lands on an
 * unrelated account — 2 out of 3 real sampled creates had a non-mint address there.
 *
 * `preTokenBalances`/`postTokenBalances` name the actual mint directly (no
 * positional guessing) regardless of transaction shape, so they're used instead.
 */
export function extractMintFromParsedTx(tx: ParsedTxLike): string | undefined {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  const preMints = new Set(pre.map((b) => b.mint).filter((m) => !NEVER_THE_LAUNCHED_MINT.has(m)));
  const postMints = new Set(post.map((b) => b.mint).filter((m) => !NEVER_THE_LAUNCHED_MINT.has(m)));

  const newMints = [...postMints].filter((m) => !preMints.has(m));
  if (newMints.length === 1) return newMints[0];

  // A mint whose associated token account is initialized and funded within the
  // same transaction can show up in both pre- and post-balances; if there's
  // exactly one distinct mint touched at all, it's unambiguous.
  if (newMints.length === 0 && postMints.size === 1) return [...postMints][0];

  // More than one candidate mint (or none at all) — can't confidently resolve,
  // so the caller should skip this event rather than guess wrong.
  return undefined;
}
