-- AlterTable
ALTER TABLE "business_settings" ADD COLUMN     "liquidityDepthWeightBps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "opportunity_score_logs" ADD COLUMN     "liquidityDepthScore" DOUBLE PRECISION;
