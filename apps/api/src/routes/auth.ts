import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { generateUniqueReferralCode } from '../lib/referral.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10),
  // The referral code of an existing user, if this signup came from an invite link.
  referralCode: z.string().trim().min(4).max(32).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const hash = Buffer.from(hashHex, 'hex');
  const candidate = scryptSync(password, salt, 64);
  return candidate.length === hash.length && timingSafeEqual(candidate, hash);
}

// Credential-stuffing/brute-force guard, tighter than the global 100/min limit.
const AUTH_RATE_LIMIT = { max: 8, timeWindow: '1 minute' };

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/auth/register', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const existing = await fastify.prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return reply.code(409).send({ error: 'Email already registered' });
    }

    let referrer: { id: string; referralCode: string | null } | null = null;
    if (body.referralCode) {
      referrer = await fastify.prisma.user.findUnique({
        where: { referralCode: body.referralCode.toUpperCase() },
        select: { id: true, referralCode: true },
      });
      if (!referrer) {
        return reply.code(400).send({ error: 'Invalid referral code' });
      }
    }

    const user = await fastify.prisma.user.create({
      data: {
        email: body.email,
        passwordHash: hashPassword(body.password),
        referralCode: await generateUniqueReferralCode(fastify.prisma),
        referredByCode: referrer?.referralCode,
      },
    });
    await fastify.prisma.auditLog.create({
      data: { userId: user.id, action: 'auth.register', ip: req.ip },
    });

    const token = fastify.jwt.sign({ userId: user.id, role: user.role });
    return reply.code(201).send({ token });
  });

  fastify.post('/auth/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = await fastify.prisma.user.findUnique({ where: { email: body.email } });
    if (!user?.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
      await fastify.prisma.auditLog.create({
        data: { action: 'auth.login_failed', ip: req.ip, metadata: { email: body.email } },
      });
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    await fastify.prisma.auditLog.create({
      data: { userId: user.id, action: 'auth.login', ip: req.ip },
    });
    const token = fastify.jwt.sign({ userId: user.id, role: user.role });
    return reply.send({ token });
  });

  fastify.get('/auth/me', { preHandler: fastify.authenticate }, async (req) => {
    const user = await fastify.prisma.user.findUniqueOrThrow({ where: { id: req.user.userId } });
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      subscriptionTier: user.subscriptionTier,
      referralCode: user.referralCode,
    };
  });
}
