# Flash-loan arbitrage execution

This branch now contains the safety/evaluation layer for moving GSP Bank Sniper from quote-only arbitrage toward atomic Project 0 flash-loan execution.

## Current state

The existing public terminal and `ArbitrageScanner` remain observation/paper-only. They do not sign or submit trades.

The new `apps/api/src/trading/flashArbitrage.ts` layer is deliberately fail-closed:

1. validates that both Jupiter quote legs chain exactly through the first leg's `otherAmountThreshold`;
2. calculates profit from the second leg's guaranteed `otherAmountThreshold`, not optimistic `outAmount`;
3. subtracts an explicit execution-cost reserve;
4. rejects stale quotes, excessive price impact, an oversized borrow, or net edge below the configured minimum;
5. always simulates an atomic flash-loan build before any submit;
6. requires a second independent LIVE gate before `submit()` can ever run.

There is no concrete Project 0 adapter wired into the worker yet, so **no flash loan or real arbitrage trade is enabled by this commit**.

## Protocol integration target

Project 0's current SDK is `@0dotxyz/p0-ts-sdk >= 2.8.0`. The concrete adapter must build one versioned transaction in this order:

```text
begin flash loan
borrow base asset (initially USDC)
Jupiter swap instructions: USDC -> intermediate asset on venue A
Jupiter swap instructions: intermediate asset -> USDC on venue B
repay borrowed USDC
end flash loan / final health check
```

The implementation must use `MarginfiAccountWrapper.makeFlashLoanTx`, include Project 0 and Jupiter address lookup tables, run the SDK transaction-size/account-lock precheck, and then call Solana `simulateTransaction`. Only a successful simulation may reach the submit method.

Project 0 currently documents a 1232-byte v0 transaction cap and 64 account locks for this composition. A route that does not fit must be rejected rather than split, because splitting would destroy flash-loan atomicity.

## Initial operator limits

The environment schema reserves these defaults for the next wiring phase:

- `FLASH_ARBITRAGE_ENABLED=false`
- `FLASH_ARBITRAGE_LIVE_EXECUTION_ENABLED=false`
- `FLASH_ARBITRAGE_MAX_BORROW_USDC=10000`
- `FLASH_ARBITRAGE_MIN_NET_BPS=30` (0.30% guaranteed net edge)
- `FLASH_ARBITRAGE_MAX_PRICE_IMPACT_BPS=25` (0.25% per leg)
- `FLASH_ARBITRAGE_MAX_QUOTE_AGE_MS=5000`

Both feature flags remain false by default. The live flag is intentionally separate from the feature/simulation flag.

## Before mainnet live execution

The concrete adapter still needs:

- a dedicated operator Solana public key / signer on the server (never committed);
- a Project 0 margin account controlled by that signer;
- the Project 0 SDK dependency and lockfile update;
- USDC bank discovery and borrow/repay instruction construction;
- Jupiter composable swap instructions (or current Swap V2 Router raw instructions);
- address lookup table loading and transaction-size checks;
- realized-PnL persistence from confirmed on-chain balances;
- daily loss and per-trade notional limits tied into the existing kill switch;
- mainnet simulation telemetry proving the selected routes fit and repay atomically.

Do not enable LIVE from quote observations alone. A positive sequential quote is not proof that an atomic flash-loan transaction will land profitably.
