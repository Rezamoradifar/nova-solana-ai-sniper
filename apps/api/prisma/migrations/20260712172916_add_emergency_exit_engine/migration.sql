-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "devWalletAddress" TEXT,
ADD COLUMN     "devWalletAmountRawAtEntry" TEXT;

-- CreateTable
CREATE TABLE "emergency_exit_logs" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "liquidityUsd" DOUBLE PRECISION,
    "ruleScore" DOUBLE PRECISION,
    "txSignature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_exit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "emergency_exit_logs_positionId_idx" ON "emergency_exit_logs"("positionId");

-- AddForeignKey
ALTER TABLE "emergency_exit_logs" ADD CONSTRAINT "emergency_exit_logs_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
