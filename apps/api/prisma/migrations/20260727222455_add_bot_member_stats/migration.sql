-- CreateTable
CREATE TABLE "bot_member_stats" (
    "id" TEXT NOT NULL DEFAULT 'bot_member_stats',
    "lastNotifiedCount" INTEGER NOT NULL DEFAULT 0,
    "lastMilestone" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_member_stats_pkey" PRIMARY KEY ("id")
);
