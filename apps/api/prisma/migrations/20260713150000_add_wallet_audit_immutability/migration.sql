-- Wallet UX + Audit: balance cache on wallets, structured fields + immutability
-- on audit_logs. Additive only — every new column is nullable or defaulted,
-- no backfill needed, no existing query shape changes.

-- CreateEnum
CREATE TYPE "AuditStatus" AS ENUM ('SUCCESS', 'FAILED', 'PENDING');

-- AlterTable: wallet balance cache (backs "Current Balance"/"Last Updated" in
-- the Telegram + Dashboard wallet UX without a live RPC call on every render).
ALTER TABLE "wallets" ADD COLUMN     "lastKnownBalanceLamports" BIGINT,
ADD COLUMN     "balanceUpdatedAt" TIMESTAMP(3);

-- AlterTable: structured audit fields. status defaults to 'SUCCESS' so every
-- pre-existing row (and every pre-existing .create() call site that doesn't
-- set it) reads as what actually happened — a successful event.
ALTER TABLE "audit_logs" ADD COLUMN     "walletId" TEXT,
ADD COLUMN     "status" "AuditStatus" NOT NULL DEFAULT 'SUCCESS',
ADD COLUMN     "txSignature" TEXT;

-- CreateIndex
CREATE INDEX "audit_logs_walletId_idx" ON "audit_logs"("walletId");

-- AddForeignKey (SetNull, not Cascade — a hard-deleted wallet must never take
-- its own audit trail down with it).
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Immutability: a BEFORE UPDATE/DELETE trigger, not a REVOKE. This app's own
-- DB role ("nova") owns the audit_logs table, and Postgres table owners
-- always bypass GRANT/REVOKE privilege checks on their own tables — so a
-- REVOKE UPDATE/DELETE here would be a silent no-op, not real enforcement. A
-- trigger fires for every writer regardless of ownership, so this is the only
-- reliable way to make "immutable" actually true. Disabling it later requires
-- an explicit, loud ALTER TABLE ... DISABLE TRIGGER statement, never a silent
-- app-level oversight.
CREATE OR REPLACE FUNCTION audit_logs_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs rows are immutable: % is not permitted (row id: %)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_prevent_update
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();

CREATE TRIGGER audit_logs_prevent_delete
  BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();
