-- AlterTable
-- Additive, nullable column — every existing row gets walletId = NULL, which
-- AutoTrader treats identically to today's behavior (falls back to the
-- user's first active wallet). No existing data is modified or removed.
ALTER TABLE "snipe_configs" ADD COLUMN "walletId" TEXT;

-- CreateIndex
CREATE INDEX "snipe_configs_walletId_idx" ON "snipe_configs"("walletId");

-- AddForeignKey
ALTER TABLE "snipe_configs" ADD CONSTRAINT "snipe_configs_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
