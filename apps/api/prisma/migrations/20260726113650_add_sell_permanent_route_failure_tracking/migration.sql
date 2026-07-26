-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "noRouteSellFailureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sellUnsellable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unsellableAt" TIMESTAMP(3),
ADD COLUMN     "unsellableReason" TEXT;
