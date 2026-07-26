-- CreateTable
CREATE TABLE "pnl_reconciliation_log" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "oldValue" TEXT NOT NULL,
    "newValue" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pnl_reconciliation_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pnl_reconciliation_log_batchId_idx" ON "pnl_reconciliation_log"("batchId");

-- CreateIndex
CREATE INDEX "pnl_reconciliation_log_tableName_recordId_idx" ON "pnl_reconciliation_log"("tableName", "recordId");
