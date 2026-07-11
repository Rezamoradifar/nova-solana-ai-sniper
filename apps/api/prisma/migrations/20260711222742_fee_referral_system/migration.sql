-- AlterTable
ALTER TABLE "users" ADD COLUMN     "feePolicyAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "feePolicyAcceptedFeeBps" INTEGER;

-- CreateTable
CREATE TABLE "business_settings" (
    "id" TEXT NOT NULL,
    "performanceFeeBps" INTEGER NOT NULL DEFAULT 2000,
    "referralProgramEnabled" BOOLEAN NOT NULL DEFAULT true,
    "maxReferralDepth" INTEGER NOT NULL DEFAULT 2,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_level_configs" (
    "id" TEXT NOT NULL,
    "businessSettingsId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "percentBps" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "referral_level_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_fee_ledger" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "sellTradeId" TEXT,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "grossProfitUsd" DOUBLE PRECISION NOT NULL,
    "tradingCostsUsd" DOUBLE PRECISION NOT NULL,
    "netProfitUsd" DOUBLE PRECISION NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "feeUsd" DOUBLE PRECISION NOT NULL,
    "userShareUsd" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_fee_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_rewards" (
    "id" TEXT NOT NULL,
    "performanceFeeLedgerId" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "percentBps" INTEGER NOT NULL,
    "rewardUsd" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_level_configs_businessSettingsId_level_key" ON "referral_level_configs"("businessSettingsId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "performance_fee_ledger_positionId_key" ON "performance_fee_ledger"("positionId");

-- CreateIndex
CREATE INDEX "performance_fee_ledger_userId_idx" ON "performance_fee_ledger"("userId");

-- CreateIndex
CREATE INDEX "performance_fee_ledger_createdAt_idx" ON "performance_fee_ledger"("createdAt");

-- CreateIndex
CREATE INDEX "referral_rewards_referrerUserId_idx" ON "referral_rewards"("referrerUserId");

-- CreateIndex
CREATE INDEX "referral_rewards_performanceFeeLedgerId_idx" ON "referral_rewards"("performanceFeeLedgerId");

-- AddForeignKey
ALTER TABLE "referral_level_configs" ADD CONSTRAINT "referral_level_configs_businessSettingsId_fkey" FOREIGN KEY ("businessSettingsId") REFERENCES "business_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_fee_ledger" ADD CONSTRAINT "performance_fee_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_performanceFeeLedgerId_fkey" FOREIGN KEY ("performanceFeeLedgerId") REFERENCES "performance_fee_ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
