-- CreateEnum
CREATE TYPE "SmartWalletEntryStatus" AS ENUM ('OPEN', 'EXITED', 'EXPIRED', 'RUG_FLAGGED');

-- CreateEnum
CREATE TYPE "ShadowDecision" AS ENUM ('BUY', 'WATCH', 'SKIP');

-- AlterTable
ALTER TABLE "smart_wallets" ADD COLUMN     "avgRoiPercent" DOUBLE PRECISION,
ADD COLUMN     "confidenceScore" DOUBLE PRECISION,
ADD COLUMN     "earlyEntryRatePct" DOUBLE PRECISION,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "lastScoredAt" TIMESTAMP(3),
ADD COLUMN     "medianRoiPercent" DOUBLE PRECISION,
ADD COLUMN     "realizedPnlUsd" DOUBLE PRECISION,
ADD COLUMN     "rugExposureRatePct" DOUBLE PRECISION,
ADD COLUMN     "sampleSize" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sybilClusterId" TEXT,
ADD COLUMN     "sybilConfidencePct" DOUBLE PRECISION,
ADD COLUMN     "unrealizedPnlUsd" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "smart_wallet_token_entries" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "tokenId" TEXT,
    "entrySignature" TEXT NOT NULL,
    "entryAt" TIMESTAMP(3) NOT NULL,
    "entryPriceUsd" DOUBLE PRECISION,
    "entryMarketCapUsd" DOUBLE PRECISION,
    "secondsAfterPoolCreation" INTEGER,
    "exitSignature" TEXT,
    "exitAt" TIMESTAMP(3),
    "exitPriceUsd" DOUBLE PRECISION,
    "realizedRoiPercent" DOUBLE PRECISION,
    "lastMarkPriceUsd" DOUBLE PRECISION,
    "lastMarkAt" TIMESTAMP(3),
    "unrealizedRoiPercent" DOUBLE PRECISION,
    "status" "SmartWalletEntryStatus" NOT NULL DEFAULT 'OPEN',
    "isRugOrScam" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "smart_wallet_token_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shadow_mode_decision_logs" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "safetyScore" DOUBLE PRECISION NOT NULL,
    "aiScore" DOUBLE PRECISION,
    "smartMoneyScore" DOUBLE PRECISION,
    "earlyMomentumScore" DOUBLE PRECISION,
    "opportunityScore" DOUBLE PRECISION NOT NULL,
    "smartMoneyClusterBuy" BOOLEAN NOT NULL DEFAULT false,
    "clusterWalletCount" INTEGER,
    "sybilDiscountApplied" BOOLEAN NOT NULL DEFAULT false,
    "momentumBreakdown" JSONB,
    "hypotheticalDecision" "ShadowDecision" NOT NULL,
    "reasons" JSONB NOT NULL,
    "priceAtDetectionUsd" DOUBLE PRECISION,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price5mUsd" DOUBLE PRECISION,
    "price15mUsd" DOUBLE PRECISION,
    "price1hUsd" DOUBLE PRECISION,
    "price4hUsd" DOUBLE PRECISION,
    "price24hUsd" DOUBLE PRECISION,
    "sampledAt24h" TIMESTAMP(3),
    "wasRugOrScamBySample" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shadow_mode_decision_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "smart_wallet_token_entries_walletAddress_idx" ON "smart_wallet_token_entries"("walletAddress");

-- CreateIndex
CREATE INDEX "smart_wallet_token_entries_mint_idx" ON "smart_wallet_token_entries"("mint");

-- CreateIndex
CREATE INDEX "smart_wallet_token_entries_entryAt_idx" ON "smart_wallet_token_entries"("entryAt");

-- CreateIndex
CREATE UNIQUE INDEX "smart_wallet_token_entries_walletAddress_mint_entrySignatur_key" ON "smart_wallet_token_entries"("walletAddress", "mint", "entrySignature");

-- CreateIndex
CREATE INDEX "shadow_mode_decision_logs_tokenId_idx" ON "shadow_mode_decision_logs"("tokenId");

-- CreateIndex
CREATE INDEX "shadow_mode_decision_logs_detectedAt_idx" ON "shadow_mode_decision_logs"("detectedAt");

-- CreateIndex
CREATE INDEX "shadow_mode_decision_logs_hypotheticalDecision_idx" ON "shadow_mode_decision_logs"("hypotheticalDecision");

-- CreateIndex
CREATE INDEX "smart_wallets_confidenceScore_idx" ON "smart_wallets"("confidenceScore");

-- CreateIndex
CREATE INDEX "smart_wallets_sybilClusterId_idx" ON "smart_wallets"("sybilClusterId");

-- AddForeignKey
ALTER TABLE "smart_wallet_token_entries" ADD CONSTRAINT "smart_wallet_token_entries_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "smart_wallets"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_wallet_token_entries" ADD CONSTRAINT "smart_wallet_token_entries_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shadow_mode_decision_logs" ADD CONSTRAINT "shadow_mode_decision_logs_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
