-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "exitReason" TEXT,
ADD COLUMN     "institutionalModeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "moonbagReserveAmountToken" DOUBLE PRECISION,
ADD COLUMN     "originalAmountToken" DOUBLE PRECISION,
ADD COLUMN     "partialTakeProfitTiers" JSONB,
ADD COLUMN     "remainingAmountToken" DOUBLE PRECISION,
ADD COLUMN     "riskScoreAtEntry" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "snipe_configs" ADD COLUMN     "institutionalModeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "moonbagPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "partialTakeProfitTiers" JSONB;

-- CreateTable
CREATE TABLE "position_partial_exits" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "tierIndex" INTEGER NOT NULL,
    "gainPercent" DOUBLE PRECISION NOT NULL,
    "tokenAmountSold" DOUBLE PRECISION NOT NULL,
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "realizedPnlUsd" DOUBLE PRECISION NOT NULL,
    "txSignature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_partial_exits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "position_partial_exits_positionId_idx" ON "position_partial_exits"("positionId");

-- AddForeignKey
ALTER TABLE "position_partial_exits" ADD CONSTRAINT "position_partial_exits_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
