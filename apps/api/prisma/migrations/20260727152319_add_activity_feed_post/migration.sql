-- CreateTable
CREATE TABLE "activity_feed_posts" (
    "id" TEXT NOT NULL,
    "feedType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_feed_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_feed_posts_feedType_idx" ON "activity_feed_posts"("feedType");

-- CreateIndex
CREATE UNIQUE INDEX "activity_feed_posts_feedType_refId_key" ON "activity_feed_posts"("feedType", "refId");
