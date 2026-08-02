-- AlterTable
ALTER TABLE "smart_wallet_token_entries"
  ADD COLUMN "entryAmountTokenUi" DOUBLE PRECISION,
  ADD COLUMN "entryAmountSol" DOUBLE PRECISION,
  ADD COLUMN "exitAmountTokenUi" DOUBLE PRECISION,
  ADD COLUMN "exitAmountSol" DOUBLE PRECISION,
  ADD COLUMN "realizedPnlSol" DOUBLE PRECISION,
  ADD COLUMN "realizedPnlUsd" DOUBLE PRECISION;
