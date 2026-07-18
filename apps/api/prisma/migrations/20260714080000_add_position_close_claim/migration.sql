-- Production blocking fix (2026-07-14): DB-backed mutual-exclusion claim for
-- every money-moving action on a Position (full close via closePosition,
-- partial sell via executePartialSell). Prevents the same position from
-- being closed/sold twice by two concurrent callers (e.g. PriceMonitor's
-- normal TP/SL tick racing EmergencyExitMonitor's tick), which was possible
-- before since neither held any lock until after a swap had already landed
-- on-chain. See positionCloseLock.ts.
--
-- positionId as the primary key is the concurrency guarantee itself: a claim
-- is a plain INSERT, and Postgres's own primary-key uniqueness check means
-- two concurrent INSERTs for the same positionId can never both succeed.

CREATE TABLE "position_close_claims" (
    "positionId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_close_claims_pkey" PRIMARY KEY ("positionId")
);
