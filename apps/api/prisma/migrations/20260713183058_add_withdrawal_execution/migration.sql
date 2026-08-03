-- AlterTable
ALTER TABLE "withdrawal_requests" ADD COLUMN     "executedAt" TIMESTAMP(3),
ADD COLUMN     "executionLamports" BIGINT,
ADD COLUMN     "txSignature" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_requests_txSignature_key" ON "withdrawal_requests"("txSignature");
