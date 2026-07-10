import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  generateWallet,
  importWalletFromSecretKey,
  decryptSecret,
  createWalletBackup,
  restoreWalletBackup,
  walletBackupSchema,
} from '@nova/shared';

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
      select: { id: true, label: true, publicKey: true, isActive: true, createdAt: true },
    });
    return wallets;
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
      data: { userId: req.user.userId, action: 'wallet.create', metadata: { walletId: wallet.id } },
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
      data: { userId: req.user.userId, action: 'wallet.import', metadata: { walletId: wallet.id } },
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
}
