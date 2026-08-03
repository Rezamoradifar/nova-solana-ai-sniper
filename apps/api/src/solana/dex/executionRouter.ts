/**
 * Execution routing decision (2026-07-29) — the pure "given a Jupiter quote
 * and a native-DEX quote, which is actually better" comparison the spec's
 * routing-engine requirement asks for (latency/slippage/liquidity/price —
 * price is what this compares directly; the other three are inputs a caller
 * already has by the time it has both quotes in hand: Jupiter's own
 * `prepareSwap` already measures its own latency/slippage, and a native
 * adapter's `isExecutable`/pool depth are what determine whether a
 * comparison is even possible).
 *
 * **Not yet wired into positionManager.ts's sendSwap** — deliberately, not
 * an oversight. Two real obstacles found during implementation:
 *
 * 1. sendSwap's `getFallbackTarget` callback is lazily resolved (only called
 *    after a Jupiter failure) specifically to avoid an extra DB read on the
 *    overwhelmingly common "Jupiter just works" path. For a SELL, the target
 *    dex is already free (position.token.dex is already loaded); for a BUY,
 *    resolving it eagerly costs a real `prisma.token.findUnique` call on
 *    every single buy attempt, for a comparison that's moot unless a real,
 *    isExecutable native adapter exists for that exact token's DEX — today
 *    that's zero tokens by default (PumpSwap's own executor is fallback-only
 *    by design, per its own header: "Jupiter already routes through
 *    PumpSwap"; Raydium's is real but deliberately not wired as the default
 *    executor pending live verification — see raydiumExecutor.ts).
 * 2. A real price comparison needs a native quote in the same raw
 *    (non-decimal-adjusted) units Jupiter's quote uses. DexAdapter.getLiquidity
 *    today returns UI-adjusted reserves (via each DEX's existing liquidity
 *    reader); computing a comparable raw quote needs its own fresh raw vault
 *    balance read (what each executor's buildSwap already does internally)
 *    — a new DexAdapter.getQuote(params) surface, not yet built, to avoid
 *    duplicating that fetch ad hoc.
 *
 * Given the comparison is moot in production today (no default-enabled
 * native executor to compare against), this ships as a correct, tested,
 * ready-to-wire building block rather than a hasty change to sendSwap's
 * already dense, incident-driven reliability logic. Wiring it in later needs:
 * a `DexAdapter.getQuote` method, an eager-but-only-for-SELL target
 * resolution (or an explicit opt-in flag for BUY), and a call to
 * `selectExecutionRoute` before sendSwap's existing buildLoop — the existing
 * Jupiter-then-native-fallback logic stays as the safety net exactly as it
 * is today either way.
 */

export interface ExecutionRouteDecision {
  selected: 'jupiter' | 'native';
  jupiterOutputAmount: bigint;
  nativeOutputAmount: bigint | undefined;
}

/**
 * Pure comparison: picks whichever quote yields more output, given the same
 * input amount on both sides. `nativeOutputAmount` is undefined when no
 * comparable native quote was available (no executable adapter, or the pool
 * has no depth) — always resolves to Jupiter in that case, matching today's
 * unconditional "Jupiter first" behavior exactly.
 */
export function selectExecutionRoute(
  jupiterOutputAmount: bigint,
  nativeOutputAmount: bigint | undefined,
): ExecutionRouteDecision {
  if (nativeOutputAmount === undefined || nativeOutputAmount <= 0n) {
    return { selected: 'jupiter', jupiterOutputAmount, nativeOutputAmount };
  }
  return {
    selected: nativeOutputAmount > jupiterOutputAmount ? 'native' : 'jupiter',
    jupiterOutputAmount,
    nativeOutputAmount,
  };
}
