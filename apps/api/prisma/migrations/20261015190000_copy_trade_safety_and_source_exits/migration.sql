ALTER TABLE "tokens" ADD COLUMN "deployerAddress" TEXT;
ALTER TABLE "positions" ADD COLUMN "copyTradeTargetAddress" TEXT;

CREATE INDEX "tokens_deployerAddress_idx" ON "tokens"("deployerAddress");
CREATE INDEX "positions_copyTradeTargetAddress_status_idx" ON "positions"("copyTradeTargetAddress", "status");
