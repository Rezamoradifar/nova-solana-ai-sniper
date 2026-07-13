import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  generateWallet,
  importWalletFromSecretKey,
  decryptSecret,
  createWalletBackup,
  restoreWalletBackup,
  walletBackupSchema,
  refreshWalletBalance,
  writeLedgerAndAudit,
} from '@nova/shared';

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const transactionsQuerySchema = historyQuerySchema.extend({
  type: z
    .enum([
      'DEPOSIT',
      'WITHDRAWAL',
      'REFERRAL_CREDIT',
      'PROFIT_CREDIT',
      'OWNER_FEE',
      'LEDGER_ADJUSTMENT',
    ])
    .optional(),
});

const withdrawalSchema = z.object({
  // Numeric string so arbitrarily large lamport amounts survive JSON
  // transport without float precision loss — coerced to BigInt below.
  amountLamports: z.string().regex(/^\d+$/, 'amountLamports must be a positive integer string'),
  txSignature: z.string().min(1),
  note: z.string().optional(),
});

/** BigInt fields aren't JSON-serializable by Fastify's default serializer —
 * every response that includes wallet/ledger balance fields must go through
 * this instead of being returned raw. */
function serializeWallet(w: {
  id: string;
  label: string;
  publicKey: string;
  isActive: boolean;
  createdAt: Date;
  lastKnownBalanceLamports: bigint | null;
  balanceUpdatedAt: Date | null;
}) {
  return {
    id: w.id,
    label: w.label,
    publicKey: w.publicKey,
    isActive: w.isActive,
    createdAt: w.createdAt,
    lastKnownBalanceLamports: w.lastKnownBalanceLamports?.toString() ?? null,
    balanceUpdatedAt: w.balanceUpdatedAt,
  };
}

function serializeLedgerEntry(e: {
  id: string;
  type: string;
  asset: string;
  direction: string;
  amountLamports: bigint | null;
  amountUsd: number | null;
  balanceAfterLamports: bigint | null;
  txSignature: string | null;
  status: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}) {
  return {
    ...e,
    amountLamports: e.amountLamports?.toString() ?? null,
    balanceAfterLamports: e.balanceAfterLamports?.toString() ?? null,
  };
}

const importSchema = z.object({
  label: z.string().min(1),
  secretKeyBase58: z.string().min(1),
});

const createSchema = z.object({
  label: z.string().min(1),
});

const backupSchema = z.object({
  password: z.string().min(8),
});

const restoreSchema = z.object({
  label: z.string().min(1),
  password: z.string().min(8),
  backup: walletBackupSchema,
});

export default async function walletRoutes(fastify: FastifyInstance) {
  fastify.get('/wallets', { preHandler: fastify.authenticate }, async (req) => {
    const wallets = await fastify.prisma.wallet.findMany({
      where: { userId: req.user.userId },
      select: {
        id: true,
        label: true,
        publicKey: true,
        isActive: true,
        createdAt: true,
        lastKnownBalanceLamports: true,
        balanceUpdatedAt: true,
      },
    });
    return wallets.map(serializeWallet);
  });

  // "Full wallet page" detail view — label/publicKey/status plus the cached
  // balance fields (populated by DepositMonitor / refresh-balance below).
  fastify.get('/wallets/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const wallet = await fastify.prisma.wallet.findUnique({ where: { id } });
    if (!wallet || wallet.userId !== req.user.userId) {
      return reply.code(404).send({ error: 'Wallet not found' });
    }
    return serializeWallet(wallet);
  });

  fastify.post('/wallets', { preHandler: fastify.authenticate }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const sealed = generateWallet(fastify.config.ENCRYPTION_KEY);
    const wallet = await fastify.prisma.wallet.create({
      data: {
        userId: req.user.userId,
        label: body.label,
        publicKey: sealed.publicKey,
        encryptedSecret: sealed.encryptedSecret,
      },
    });
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        walletId: wallet.id,
        action: 'wallet.create',
        metadata: { walletId: wallet.id },
      },
    });
    // The mnemonic is returned exactly once, right here, and is never stored —
    // the client must show it to the user immediately and then discard it.
    return reply.code(201).send({
      id: wallet.id,
      label: wallet.label,
      publicKey: wallet.publicKey,
      mnemonic: sealed.mnemonic,
    });
  });

  fastify.post('/wallets/import', { preHandler: fastify.authenticate }, async (req, reply) => {
    const body = importSchema.parse(req.body);
    let sealed: ReturnType<typeof importWalletFromSecretKey>;
    try {
      sealed = importWalletFromSecretKey(body.secretKeyBase58, fastify.config.ENCRYPTION_KEY);
    } catch {
      // Malformed input (bad base58 / wrong key length), not a server error.
      return reply.code(400).send({ error: 'Invalid secret key' });
    }
    const wallet = await fastify.prisma.wallet.create({
      data: {
        userId: req.user.userId,
        label: body.label,
        publicKey: sealed.publicKey,
        encryptedSecret: sealed.encryptedSecret,
      },
    });
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        walletId: wallet.id,
        action: 'wallet.import',
        metadata: { walletId: wallet.id },
      },
    });
    return reply
      .code(201)
      .send({ id: wallet.id, label: wallet.label, publicKey: wallet.publicKey });
  });

  // Exports an AES-256-GCM-encrypted backup of the wallet's secret key, keyed to a
  // password the caller chooses here (independent of ENCRYPTION_KEY) — the file is
  // useless without that password, and the plaintext secret never leaves this handler.
  fastify.post('/wallets/:id/backup', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = backupSchema.parse(req.body);
    const wallet = await fastify.prisma.wallet.findUnique({ where: { id } });
    if (!wallet || wallet.userId !== req.user.userId) {
      return reply.code(404).send({ error: 'Wallet not found' });
    }
    const secretKeyBase58 = decryptSecret(wallet.encryptedSecret, fastify.config.ENCRYPTION_KEY);
    const backup = createWalletBackup(secretKeyBase58, wallet.publicKey, body.password);
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        walletId: wallet.id,
        action: 'wallet.backup_exported',
        metadata: { walletId: wallet.id },
      },
    });
    return reply.send(backup);
  });

  fastify.post('/wallets/restore', { preHandler: fastify.authenticate }, async (req, reply) => {
    const body = restoreSchema.parse(req.body);

    let secretKeyBase58: string;
    try {
      secretKeyBase58 = restoreWalletBackup(body.backup, body.password);
    } catch {
      // Wrong password or a corrupted/tampered file both fail GCM's auth-tag check.
      return reply.code(400).send({ error: 'Incorrect password or corrupted backup file' });
    }

    let sealed: ReturnType<typeof importWalletFromSecretKey>;
    try {
      sealed = importWalletFromSecretKey(secretKeyBase58, fastify.config.ENCRYPTION_KEY);
    } catch {
      return reply.code(400).send({ error: 'Backup did not contain a valid wallet secret key' });
    }

    const existing = await fastify.prisma.wallet.findUnique({
      where: { publicKey: sealed.publicKey },
    });

    // Wallets are soft-deleted (isActive: false), so restoring one you previously
    // removed should reactivate it rather than fail on the unique constraint.
    if (existing) {
      if (existing.userId !== req.user.userId) {
        return reply.code(409).send({ error: 'This wallet has already been added' });
      }
      if (existing.isActive) {
        return reply.code(409).send({ error: 'This wallet is already active' });
      }
      const reactivated = await fastify.prisma.wallet.update({
        where: { id: existing.id },
        data: { isActive: true, label: body.label },
      });
      await fastify.prisma.auditLog.create({
        data: {
          userId: req.user.userId,
          walletId: reactivated.id,
          action: 'wallet.restore',
          metadata: { walletId: reactivated.id },
        },
      });
      return reply
        .code(200)
        .send({ id: reactivated.id, label: reactivated.label, publicKey: reactivated.publicKey });
    }

    const wallet = await fastify.prisma.wallet.create({
      data: {
        userId: req.user.userId,
        label: body.label,
        publicKey: sealed.publicKey,
        encryptedSecret: sealed.encryptedSecret,
      },
    });
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        walletId: wallet.id,
        action: 'wallet.restore',
        metadata: { walletId: wallet.id },
      },
    });
    return reply
      .code(201)
      .send({ id: wallet.id, label: wallet.label, publicKey: wallet.publicKey });
  });

  fastify.delete('/wallets/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const wallet = await fastify.prisma.wallet.findUnique({ where: { id } });
    if (!wallet || wallet.userId !== req.user.userId) {
      return reply.code(404).send({ error: 'Wallet not found' });
    }
    await fastify.prisma.wallet.update({ where: { id }, data: { isActive: false } });
    return reply.code(204).send();
  });

  // On-demand version of what DepositMonitor already does on a timer (see
  // apps/api/src/monitors/depositMonitor.ts) — both call the exact same
  // refreshWalletBalance helper from @nova/shared, so a manual refresh and a
  // poll tick can never disagree about what counts as a deposit.
  fastify.post(
    '/wallets/:id/refresh-balance',
    { preHandler: fastify.authenticate },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const wallet = await fastify.prisma.wallet.findUnique({ where: { id } });
      if (!wallet || wallet.userId !== req.user.userId) {
        return reply.code(404).send({ error: 'Wallet not found' });
      }
      if (!fastify.solanaConnection) {
        return reply.code(503).send({ error: 'Solana RPC connection not available' });
      }
      const result = await refreshWalletBalance(
        {
          prisma: fastify.prisma,
          connection: fastify.solanaConnection,
          logger: fastify.log as never,
        },
        id,
        { ip: req.ip, source: 'refresh_endpoint' },
      );
      if (!result) {
        return reply.code(404).send({ error: 'Wallet not found or inactive' });
      }
      return {
        walletId: result.walletId,
        currentLamports: result.currentLamports.toString(),
        previousLamports: result.previousLamports?.toString() ?? null,
        deltaLamports: result.deltaLamports.toString(),
        depositRecorded: Boolean(result.depositLedgerEntryId),
      };
    },
  );

  // "Wallet History" — the compliance/security audit trail for this wallet
  // (create/import/backup/restore/deactivate plus every financial event's
  // paired AuditLog row — see writeLedgerAndAudit).
  fastify.get(
    '/wallets/:id/audit-log',
    { preHandler: fastify.authenticate },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { limit } = historyQuerySchema.parse(req.query);
      const wallet = await fastify.prisma.wallet.findUnique({ where: { id } });
      if (!wallet || wallet.userId !== req.user.userId) {
        return reply.code(404).send({ error: 'Wallet not found' });
      }
      const entries = await fastify.prisma.auditLog.findMany({
        where: { walletId: id },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return entries;
    },
  );

  // "Transaction History" — the financial ledger for this wallet (deposits,
  // admin-recorded withdrawals; profit/referral/owner-fee entries are
  // user-scoped rather than wallet-scoped, see registerFeeSystem.ts, so they
  // won't appear here).
  fastify.get(
    '/wallets/:id/transactions',
    { preHandler: fastify.authenticate },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { limit, type } = transactionsQuerySchema.parse(req.query);
      const wallet = await fastify.prisma.wallet.findUnique({ where: { id } });
      if (!wallet || wallet.userId !== req.user.userId) {
        return reply.code(404).send({ error: 'Wallet not found' });
      }
      const entries = await fastify.prisma.ledgerEntry.findMany({
        where: { walletId: id, ...(type ? { type } : {}) },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return entries.map(serializeLedgerEntry);
    },
  );

  // Admin-only, record-only: logs that a withdrawal was executed manually,
  // out-of-band. Never signs or broadcasts a transaction, never touches
  // encryptedSecret — the server's ability to unilaterally decrypt a
  // wallet's key (see packages/shared/src/security/keystore.ts) is
  // deliberately not exercised anywhere in this route. This is the entire
  // withdrawal feature: an immutable record, not a fund-movement mechanism.
  fastify.post(
    '/wallets/:id/withdrawals',
    { preHandler: fastify.requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = withdrawalSchema.parse(req.body);
      const wallet = await fastify.prisma.wallet.findUnique({ where: { id } });
      if (!wallet) {
        return reply.code(404).send({ error: 'Wallet not found' });
      }
      const amountLamports = BigInt(body.amountLamports);
      const newBalance =
        wallet.lastKnownBalanceLamports !== null
          ? wallet.lastKnownBalanceLamports - amountLamports
          : null;

      const result = await fastify.prisma.$transaction(async (tx) => {
        if (newBalance !== null) {
          await tx.wallet.update({
            where: { id },
            data: { lastKnownBalanceLamports: newBalance, balanceUpdatedAt: new Date() },
          });
        }
        return writeLedgerAndAudit(tx, {
          type: 'WITHDRAWAL',
          asset: 'SOL',
          direction: 'DEBIT',
          amountLamports,
          balanceAfterLamports: newBalance ?? undefined,
          userId: wallet.userId,
          walletId: wallet.id,
          txSignature: body.txSignature,
          action: 'wallet.withdrawal_recorded',
          metadata: { note: body.note, recordedByAdminUserId: req.user.userId },
          ip: req.ip,
        });
      });

      return reply.code(201).send({
        ledgerEntryId: result.ledgerEntryId,
        auditLogId: result.auditLogId,
        newBalanceLamports: newBalance?.toString() ?? null,
      });
    },
  );
}
