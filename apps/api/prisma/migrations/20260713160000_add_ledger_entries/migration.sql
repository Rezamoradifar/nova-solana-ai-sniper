-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'REFERRAL_CREDIT', 'PROFIT_CREDIT', 'OWNER_FEE', 'LEDGER_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "LedgerAsset" AS ENUM ('SOL', 'USD');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT,
    "type" "LedgerEntryType" NOT NULL,
    "asset" "LedgerAsset" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amountLamports" BIGINT,
    "amountUsd" DOUBLE PRECISION,
    "balanceAfterLamports" BIGINT,
    "txSignature" TEXT,
    "status" "AuditStatus" NOT NULL DEFAULT 'SUCCESS',
    "referenceType" TEXT,
    "referenceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_entries_userId_idx" ON "ledger_entries"("userId");

-- CreateIndex
CREATE INDEX "ledger_entries_walletId_idx" ON "ledger_entries"("walletId");

-- CreateIndex
CREATE INDEX "ledger_entries_type_idx" ON "ledger_entries"("type");

-- CreateIndex
CREATE INDEX "ledger_entries_createdAt_idx" ON "ledger_entries"("createdAt");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Immutability: a BEFORE UPDATE/DELETE trigger, not a REVOKE — same reasoning
-- as audit_logs (see migration 20260713150000_add_wallet_audit_immutability):
-- this app's own DB role owns the table, and Postgres table owners always
-- bypass GRANT/REVOKE privilege checks on their own tables, so only a trigger
-- makes "immutable" actually true regardless of which role writes.
CREATE OR REPLACE FUNCTION ledger_entries_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries rows are immutable: % is not permitted (row id: %)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_prevent_update
  BEFORE UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_reject_mutation();

CREATE TRIGGER ledger_entries_prevent_delete
  BEFORE DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_reject_mutation();
