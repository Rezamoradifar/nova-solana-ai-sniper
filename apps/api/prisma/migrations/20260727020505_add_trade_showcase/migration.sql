-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "showcasePostedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "trade_showcase_daily_summaries" (
    "id" TEXT NOT NULL,
    "summaryDate" TIMESTAMP(3) NOT NULL,
    "telegramMessageId" INTEGER,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_showcase_daily_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_showcase_daily_summaries_summaryDate_key" ON "trade_showcase_daily_summaries"("summaryDate");
