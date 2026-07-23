-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'SKIPPED_INSUFFICIENT_BALANCE', 'SKIPPED_PAPER_TRADE', 'SKIPPED_NO_PAYOUT_NEEDED');

-- AlterTable
ALTER TABLE "performance_fee_ledger" ADD COLUMN     "payoutTxSignature" TEXT;

-- AlterTable
ALTER TABLE "referral_rewards" ADD COLUMN     "payoutTxSignature" TEXT,
ADD COLUMN     "payoutWalletId" TEXT,
ADD COLUMN     "rolledUpToTreasury" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "payout_attempts" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "solPriceUsdAtCalc" DOUBLE PRECISION NOT NULL,
    "treasuryAddress" TEXT NOT NULL,
    "treasuryLamports" BIGINT NOT NULL,
    "referralBreakdown" JSONB NOT NULL,
    "totalLamports" BIGINT NOT NULL,
    "estimatedFeeLamports" BIGINT NOT NULL,
    "txSignature" TEXT,
    "failureReason" TEXT,
    "processingStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payout_attempts_positionId_key" ON "payout_attempts"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "payout_attempts_txSignature_key" ON "payout_attempts"("txSignature");

-- CreateIndex
CREATE INDEX "payout_attempts_status_idx" ON "payout_attempts"("status");

-- AddForeignKey
ALTER TABLE "payout_attempts" ADD CONSTRAINT "payout_attempts_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
