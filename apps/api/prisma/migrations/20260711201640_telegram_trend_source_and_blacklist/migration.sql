-- CreateEnum
CREATE TYPE "DiscoverySource" AS ENUM ('ON_CHAIN', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "BlacklistType" AS ENUM ('MINT', 'DEPLOYER');

-- AlterTable
ALTER TABLE "tokens" ADD COLUMN     "discoverySource" "DiscoverySource" NOT NULL DEFAULT 'ON_CHAIN',
ADD COLUMN     "telegramChannel" TEXT,
ADD COLUMN     "telegramMessageUrl" TEXT;

-- CreateTable
CREATE TABLE "blacklist_entries" (
    "id" TEXT NOT NULL,
    "type" "BlacklistType" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blacklist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blacklist_entries_type_value_key" ON "blacklist_entries"("type", "value");
