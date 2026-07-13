import type {
  Prisma,
  AuditStatus,
  LedgerAsset,
  LedgerDirection,
  LedgerEntryType,
} from '@prisma/client';

export interface LedgerWriteInput {
  type: LedgerEntryType;
  asset: LedgerAsset;
  direction: LedgerDirection;
  // Exactly one of these two must be set, matching `asset` — see
  // LedgerEntry's own doc comment in schema.prisma.
  amountLamports?: bigint;
  amountUsd?: number;
  balanceAfterLamports?: bigint;
  userId: string;
  walletId?: string;
  txSignature?: string;
  status?: AuditStatus;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
  // AuditLog's own free-form action string (e.g. 'wallet.deposit_detected') —
  // always required since every call site already has a natural one.
  action: string;
  ip?: string;
}

/**
 * Writes one LedgerEntry + one AuditLog row for a single balance-affecting
 * event, always together, always in the caller's own transaction client —
 * so no call site can create a ledger entry without its audit counterpart
 * (or vice versa). This is the only place either table should be written
 * from application code for financial events (deposits, admin-recorded
 * withdrawals, profit/referral/owner-fee credits).
 */
export async function writeLedgerAndAudit(
  tx: Prisma.TransactionClient,
  input: LedgerWriteInput,
): Promise<{ ledgerEntryId: string; auditLogId: string }> {
  if (input.asset === 'SOL' && input.amountLamports === undefined) {
    throw new Error(`writeLedgerAndAudit: asset=SOL requires amountLamports (type=${input.type})`);
  }
  if (input.asset === 'USD' && input.amountUsd === undefined) {
    throw new Error(`writeLedgerAndAudit: asset=USD requires amountUsd (type=${input.type})`);
  }

  const ledgerEntry = await tx.ledgerEntry.create({
    data: {
      userId: input.userId,
      walletId: input.walletId,
      type: input.type,
      asset: input.asset,
      direction: input.direction,
      amountLamports: input.amountLamports,
      amountUsd: input.amountUsd,
      balanceAfterLamports: input.balanceAfterLamports,
      txSignature: input.txSignature,
      status: input.status,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
    },
  });

  const auditLog = await tx.auditLog.create({
    data: {
      userId: input.userId,
      walletId: input.walletId,
      action: input.action,
      status: input.status,
      txSignature: input.txSignature,
      ip: input.ip,
      metadata: {
        ledgerEntryId: ledgerEntry.id,
        ...(input.walletId ? { walletId: input.walletId } : {}),
        ...(input.metadata ?? {}),
      } as Prisma.InputJsonValue,
    },
  });

  return { ledgerEntryId: ledgerEntry.id, auditLogId: auditLog.id };
}
