-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LedgerEntryType" ADD VALUE 'WITHDRAW_REQUEST';
ALTER TYPE "LedgerEntryType" ADD VALUE 'WITHDRAW_APPROVED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'WITHDRAW_REJECTED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'WITHDRAW_COMPLETED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'WITHDRAW_FAILED';

-- CreateTable
CREATE TABLE "withdrawal_settings" (
    "id" TEXT NOT NULL,
    "minWithdrawalUsd" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "maxWithdrawalUsd" DOUBLE PRECISION NOT NULL DEFAULT 5000,
    "dailyWithdrawalLimitUsd" DOUBLE PRECISION NOT NULL DEFAULT 10000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "riskScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fraudFlags" JSONB,
    "rejectionReason" TEXT,
    "reviewedByUserId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "processingAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_requests_idempotencyKey_key" ON "withdrawal_requests"("idempotencyKey");

-- CreateIndex
CREATE INDEX "withdrawal_requests_userId_idx" ON "withdrawal_requests"("userId");

-- CreateIndex
CREATE INDEX "withdrawal_requests_status_idx" ON "withdrawal_requests"("status");

-- CreateIndex
CREATE INDEX "withdrawal_requests_createdAt_idx" ON "withdrawal_requests"("createdAt");

-- DB-level backstop for the app-level duplicate-request guard in
-- withdrawalEngine.ts: at most one ACTIVE withdrawal request per user. A
-- partial unique index (not expressible in schema.prisma's DSL, same
-- reasoning as positions_wallet_token_open_unique in migration
-- 20260711033928_position_one_open_per_token) so a user's terminal
-- (REJECTED/COMPLETED/FAILED/CANCELLED) requests are unaffected and can
-- still accumulate freely — only one PENDING/UNDER_REVIEW/APPROVED/
-- PROCESSING request may exist at a time.
CREATE UNIQUE INDEX "withdrawal_requests_user_active_unique"
  ON "withdrawal_requests" ("userId")
  WHERE "status" IN ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING');
