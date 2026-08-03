-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LedgerEntryType" ADD VALUE 'PLATFORM_FEE';
ALTER TYPE "LedgerEntryType" ADD VALUE 'REFERRAL_REWARD';
ALTER TYPE "LedgerEntryType" ADD VALUE 'NET_PROFIT';

-- CreateTable
CREATE TABLE "distribution_settings" (
    "id" TEXT NOT NULL,
    "platformShareBps" INTEGER NOT NULL DEFAULT 2000,
    "distributionActivatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "distribution_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profit_distributions" (
    "id" TEXT NOT NULL,
    "performanceFeeLedgerId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "grossProfitUsd" DOUBLE PRECISION NOT NULL,
    "tradingCostsUsd" DOUBLE PRECISION NOT NULL,
    "netProfitUsd" DOUBLE PRECISION NOT NULL,
    "platformFeeUsd" DOUBLE PRECISION NOT NULL,
    "referralRewardUsd" DOUBLE PRECISION NOT NULL,
    "ownerEarningsUsd" DOUBLE PRECISION NOT NULL,
    "userProfitUsd" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profit_distributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_distribution_balances" (
    "userId" TEXT NOT NULL,
    "profitBalanceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "referralBalanceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "withdrawableBalanceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_distribution_balances_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "owner_balance" (
    "id" TEXT NOT NULL DEFAULT 'owner',
    "balanceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owner_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_balance" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "balanceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_balance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profit_distributions_performanceFeeLedgerId_key" ON "profit_distributions"("performanceFeeLedgerId");

-- CreateIndex
CREATE UNIQUE INDEX "profit_distributions_positionId_key" ON "profit_distributions"("positionId");

-- CreateIndex
CREATE INDEX "profit_distributions_userId_idx" ON "profit_distributions"("userId");

-- CreateIndex
CREATE INDEX "profit_distributions_createdAt_idx" ON "profit_distributions"("createdAt");
