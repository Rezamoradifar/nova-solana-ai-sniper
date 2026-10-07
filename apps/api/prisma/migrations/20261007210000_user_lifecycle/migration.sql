ALTER TABLE "users"
ADD COLUMN "isSuspended" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "suspendedAt" TIMESTAMP(3),
ADD COLUMN "suspensionReason" TEXT,
ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "users_isSuspended_deletedAt_idx" ON "users"("isSuspended", "deletedAt");
