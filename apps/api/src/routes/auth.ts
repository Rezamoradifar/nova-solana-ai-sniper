import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10),
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

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/auth/register', async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const existing = await fastify.prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return reply.code(409).send({ error: 'Email already registered' });
    }
    const user = await fastify.prisma.user.create({
      data: { email: body.email, passwordHash: hashPassword(body.password) },
    });
    const token = fastify.jwt.sign({ userId: user.id, role: user.role });
    return reply.code(201).send({ token });
  });

  fastify.post('/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = await fastify.prisma.user.findUnique({ where: { email: body.email } });
    if (!user?.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    const token = fastify.jwt.sign({ userId: user.id, role: user.role });
    return reply.send({ token });
  });

  fastify.get('/auth/me', { preHandler: fastify.authenticate }, async (req) => {
    const user = await fastify.prisma.user.findUniqueOrThrow({ where: { id: req.user.userId } });
    return { id: user.id, email: user.email, role: user.role };
  });
}
