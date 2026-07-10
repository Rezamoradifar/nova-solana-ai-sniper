import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateWallet, importWalletFromSecretKey } from '../security/keystore.js';

const importSchema = z.object({
  label: z.string().min(1),
  secretKeyBase58: z.string().min(1),
});

const createSchema = z.object({
  label: z.string().min(1),
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
    // Only the public key is ever returned; the encrypted secret never leaves this process.
    return reply
      .code(201)
      .send({ id: wallet.id, label: wallet.label, publicKey: wallet.publicKey });
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
