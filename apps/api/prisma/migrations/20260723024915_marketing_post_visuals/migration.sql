/*
  Warnings:

  - You are about to drop the column `imageUrl` on the `marketing_posts` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "VisualType" AS ENUM ('NONE', 'TEMPLATE_STAT', 'TEMPLATE_HEADLINE', 'AI_GENERATED');

-- AlterTable
ALTER TABLE "marketing_posts" DROP COLUMN "imageUrl",
ADD COLUMN     "imageContentHash" TEXT,
ADD COLUMN     "imagePath" TEXT,
ADD COLUMN     "telegramMessageId" INTEGER,
ADD COLUMN     "visualType" "VisualType" NOT NULL DEFAULT 'NONE';

-- CreateIndex
CREATE INDEX "marketing_posts_imageContentHash_idx" ON "marketing_posts"("imageContentHash");
