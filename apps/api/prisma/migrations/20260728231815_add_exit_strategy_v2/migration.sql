-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "exitStrategy" TEXT,
ADD COLUMN     "trailingActivatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "snipe_configs" ADD COLUMN     "exitStrategy" TEXT;
