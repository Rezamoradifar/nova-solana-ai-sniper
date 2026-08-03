-- CreateEnum
CREATE TYPE "PositionMonitoringState" AS ENUM ('NORMAL', 'PRICE_UNAVAILABLE', 'NO_SELL_ROUTE', 'MANUAL_REVIEW');

-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "lastAlertedMonitoringState" "PositionMonitoringState",
ADD COLUMN     "lastMonitoringAlertAt" TIMESTAMP(3),
ADD COLUMN     "monitoringState" "PositionMonitoringState" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "monitoringStateSince" TIMESTAMP(3);
