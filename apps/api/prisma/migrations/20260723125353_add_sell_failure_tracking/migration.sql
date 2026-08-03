-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "lastSellFailureAt" TIMESTAMP(3),
ADD COLUMN     "sellFailureCount" INTEGER NOT NULL DEFAULT 0;
