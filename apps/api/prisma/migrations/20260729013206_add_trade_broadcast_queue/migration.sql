-- AlterTable
ALTER TABLE "users" ADD COLUMN     "telegramActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "trade_broadcasts" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "caption" TEXT NOT NULL,
    "photoFileId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "totalRecipients" INTEGER,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedPermanentCount" INTEGER NOT NULL DEFAULT 0,
    "failedTempCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "trade_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_broadcast_deliveries" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_broadcast_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_broadcasts_positionId_key" ON "trade_broadcasts"("positionId");

-- CreateIndex
CREATE INDEX "trade_broadcast_deliveries_status_lastAttemptAt_idx" ON "trade_broadcast_deliveries"("status", "lastAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "trade_broadcast_deliveries_broadcastId_userId_key" ON "trade_broadcast_deliveries"("broadcastId", "userId");

-- AddForeignKey
ALTER TABLE "trade_broadcast_deliveries" ADD CONSTRAINT "trade_broadcast_deliveries_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "trade_broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_broadcast_deliveries" ADD CONSTRAINT "trade_broadcast_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
