-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "isPaperTrade" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "trades" ADD COLUMN     "isPaperTrade" BOOLEAN NOT NULL DEFAULT false;
