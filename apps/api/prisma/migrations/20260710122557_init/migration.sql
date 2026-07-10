-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'TRADER');

-- CreateEnum
CREATE TYPE "Dex" AS ENUM ('PUMPFUN', 'RAYDIUM', 'ORCA', 'JUPITER');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "MarketingCategory" AS ENUM ('NEWS', 'TRADING_TIPS', 'MARKET_UPDATES', 'TRENDING_TOKENS', 'REFERRAL', 'ANNOUNCEMENTS');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "telegramId" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'TRADER',
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "symbol" TEXT,
    "name" TEXT,
    "decimals" INTEGER NOT NULL DEFAULT 9,
    "dex" "Dex" NOT NULL,
    "poolAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liquidityUsd" DOUBLE PRECISION,
    "marketCapUsd" DOUBLE PRECISION,
    "mintAuthorityRevoked" BOOLEAN,
    "freezeAuthorityRevoked" BOOLEAN,
    "lpBurnedOrLocked" BOOLEAN,
    "top10HolderPercent" DOUBLE PRECISION,
    "isHoneypotSuspected" BOOLEAN,
    "aiScore" DOUBLE PRECISION,
    "aiSummary" TEXT,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'PENDING',
    "amountSol" DOUBLE PRECISION NOT NULL,
    "amountToken" DOUBLE PRECISION,
    "priceUsd" DOUBLE PRECISION,
    "txSignature" TEXT,
    "slippageBps" INTEGER NOT NULL DEFAULT 100,
    "jitoTip" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "entryPriceUsd" DOUBLE PRECISION NOT NULL,
    "amountToken" DOUBLE PRECISION NOT NULL,
    "amountSolInvested" DOUBLE PRECISION NOT NULL,
    "takeProfitPercent" DOUBLE PRECISION,
    "stopLossPercent" DOUBLE PRECISION,
    "trailingStopPercent" DOUBLE PRECISION,
    "highWaterMarkUsd" DOUBLE PRECISION,
    "realizedPnlUsd" DOUBLE PRECISION,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snipe_configs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "buyAmountSol" DOUBLE PRECISION NOT NULL,
    "maxSlippageBps" INTEGER NOT NULL DEFAULT 300,
    "minLiquidityUsd" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "minAiScore" DOUBLE PRECISION NOT NULL DEFAULT 60,
    "takeProfitPercent" DOUBLE PRECISION,
    "stopLossPercent" DOUBLE PRECISION,
    "trailingStopPercent" DOUBLE PRECISION,
    "autoBuyOnLaunch" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "snipe_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_wallets" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "winRate" DOUBLE PRECISION,
    "totalPnlUsd" DOUBLE PRECISION,
    "isTracked" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "smart_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copy_trade_configs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetAddress" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "copyPercentSize" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "maxAmountSol" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copy_trade_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist_items" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_posts" (
    "id" TEXT NOT NULL,
    "category" "MarketingCategory" NOT NULL,
    "contentHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "imageUrl" TEXT,
    "buttons" JSONB,
    "publishedAt" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_publicKey_key" ON "wallets"("publicKey");

-- CreateIndex
CREATE INDEX "wallets_userId_idx" ON "wallets"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_mint_key" ON "tokens"("mint");

-- CreateIndex
CREATE INDEX "tokens_dex_idx" ON "tokens"("dex");

-- CreateIndex
CREATE INDEX "tokens_createdAt_idx" ON "tokens"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "trades_txSignature_key" ON "trades"("txSignature");

-- CreateIndex
CREATE INDEX "trades_walletId_idx" ON "trades"("walletId");

-- CreateIndex
CREATE INDEX "trades_tokenId_idx" ON "trades"("tokenId");

-- CreateIndex
CREATE INDEX "positions_walletId_status_idx" ON "positions"("walletId", "status");

-- CreateIndex
CREATE INDEX "snipe_configs_userId_idx" ON "snipe_configs"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "smart_wallets_address_key" ON "smart_wallets"("address");

-- CreateIndex
CREATE INDEX "copy_trade_configs_userId_idx" ON "copy_trade_configs"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "watchlist_items_userId_mint_key" ON "watchlist_items"("userId", "mint");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_posts_contentHash_key" ON "marketing_posts"("contentHash");

-- CreateIndex
CREATE INDEX "marketing_posts_category_idx" ON "marketing_posts"("category");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snipe_configs" ADD CONSTRAINT "snipe_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snipe_configs" ADD CONSTRAINT "snipe_configs_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copy_trade_configs" ADD CONSTRAINT "copy_trade_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
