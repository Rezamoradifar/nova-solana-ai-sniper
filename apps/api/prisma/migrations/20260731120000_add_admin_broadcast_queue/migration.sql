-- CreateTable
CREATE TABLE "admin_broadcasts" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "totalRecipients" INTEGER,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedPermanentCount" INTEGER NOT NULL DEFAULT 0,
    "failedTempCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "admin_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_broadcast_deliveries" (
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

    CONSTRAINT "admin_broadcast_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_broadcast_deliveries_status_lastAttemptAt_idx" ON "admin_broadcast_deliveries"("status", "lastAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_broadcast_deliveries_broadcastId_userId_key" ON "admin_broadcast_deliveries"("broadcastId", "userId");

-- AddForeignKey
ALTER TABLE "admin_broadcast_deliveries" ADD CONSTRAINT "admin_broadcast_deliveries_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "admin_broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_broadcast_deliveries" ADD CONSTRAINT "admin_broadcast_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
