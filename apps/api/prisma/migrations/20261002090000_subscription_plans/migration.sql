-- AlterTable
ALTER TABLE "users" ADD COLUMN "planKey" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN "planExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceSol" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationDays" INTEGER NOT NULL DEFAULT 30,
    "feeBps" INTEGER,
    "maxBuySol" DOUBLE PRECISION,
    "maxOpenPositions" INTEGER,
    "autoBuyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "features" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "amountSol" DOUBLE PRECISION NOT NULL,
    "txSignature" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_txSignature_key" ON "subscriptions"("txSignature");
CREATE INDEX "subscriptions_userId_expiresAt_idx" ON "subscriptions"("userId", "expiresAt");
CREATE INDEX "subscriptions_createdAt_idx" ON "subscriptions"("createdAt");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planKey_fkey" FOREIGN KEY ("planKey") REFERENCES "subscription_plans"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the default packages (owner can change everything from the admin panel).
-- Free keeps today's behaviour: global fee, no limits.
INSERT INTO "subscription_plans" ("key", "name", "priceSol", "durationDays", "feeBps", "maxBuySol", "maxOpenPositions", "autoBuyEnabled", "features", "active", "sortOrder", "updatedAt") VALUES
('free',  'Free',  0,   3650, NULL, NULL, NULL, true, E'Auto-buy on new launches\nSecurity gate and real-value stop-loss\nTrade cards in Telegram', true, 0, CURRENT_TIMESTAMP),
('pro',   'Pro',   1.5, 30,   1500, 2,    5,    true, E'Everything in Free\nLower fee: 15% of profit\nUp to 2 SOL per buy, 5 open positions\nNetwork trade feed', true, 1, CURRENT_TIMESTAMP),
('elite', 'Elite', 4,   30,   1000, 10,   15,   true, E'Everything in Pro\nLowest fee: 10% of profit\nUp to 10 SOL per buy, 15 open positions\nArbitrage scanner reports', true, 2, CURRENT_TIMESTAMP);
