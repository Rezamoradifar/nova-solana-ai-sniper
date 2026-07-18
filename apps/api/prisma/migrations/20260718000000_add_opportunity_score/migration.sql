-- AlterTable
ALTER TABLE "business_settings" ADD COLUMN     "aiWeightBps" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "momentumWeightBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "safetyWeightBps" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "socialWeightBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "walletWeightBps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "snipe_configs" ADD COLUMN     "useOpportunityScoreGate" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "opportunity_score_logs" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "safetyScore" DOUBLE PRECISION NOT NULL,
    "momentumScore" DOUBLE PRECISION,
    "walletScore" DOUBLE PRECISION,
    "socialScore" DOUBLE PRECISION,
    "aiScore" DOUBLE PRECISION,
    "finalScore" DOUBLE PRECISION NOT NULL,
    "weightsSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opportunity_score_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "opportunity_score_logs_tokenId_idx" ON "opportunity_score_logs"("tokenId");

-- CreateIndex
CREATE INDEX "opportunity_score_logs_createdAt_idx" ON "opportunity_score_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "opportunity_score_logs" ADD CONSTRAINT "opportunity_score_logs_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

