import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isAdminUser } from '../lib/adminAccess.js';
import type { User } from '@prisma/client';
import { z } from 'zod';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  validate as validateTelegramInitData,
  parse as parseTelegramInitData,
} from '@tma.js/init-data-node';
import { generateUniqueReferralCode, maybeActivateReferralReward } from '@nova/shared';
import { createBot, sendReferralRewardNotification } from '@nova/telegram-bot';
import type { Bot } from 'grammy';

// Lazy + memoized: most registrations don't complete a referral reward, so this only
// ever constructs a bot (never started/polling — outbound sends only, same convention
// as worker.ts's NotificationService) the first time one actually needs to fire.
let referralNotifierBot: Bot | undefined;
function getReferralNotifierBot(token: string, logger: FastifyInstance['log']): Bot {
  referralNotifierBot ??= createBot(token, logger as never);
  return referralNotifierBot;
}

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

export const telegramAuthSchema = z.object({
  // The raw, signed initData string handed to the Mini App by Telegram's
  // WebView (window.Telegram.WebApp.initData) — never parsed/trusted client
  // side, verified here via HMAC-SHA256 against the bot token.
  initData: z.string().min(1),
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

function isUniqueConstraintError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/**
 * Mini App counterpart of the Telegram bot's own resolveOrCreateUser
 * (apps/telegram-bot/src/ui/user.ts) — deliberately not imported/shared with
 * it directly, since that function takes a grammy `Context` (a bot update),
 * not a bare telegramId, and apps/api has no reason to depend on
 * @nova/telegram-bot's grammy plumbing just to reuse this one shape. Same
 * find-or-create-by-telegramId behavior, same referral-activation trigger
 * point, so a user who first opens the Mini App vs. first messages the bot
 * ends up with an identical kind of account either way — just adapted to
 * this route's inputs and wrapped in a unique-constraint race guard the bot
 * path doesn't need (a Telegram update is processed one-at-a-time per chat;
 * two Mini App launches for a brand-new user can race concurrently).
 */
export async function resolveOrCreateTelegramUser(
  fastify: Pick<FastifyInstance, 'prisma' | 'config' | 'log'>,
  req: Pick<FastifyRequest, 'ip'>,
  telegramId: string,
  referralPayload: string | undefined,
): Promise<User> {
  const existing = await fastify.prisma.user.findUnique({ where: { telegramId } });
  if (existing) return existing;

  let referrer: { id: string; referralCode: string | null; telegramId: string | null } | null =
    null;
  if (referralPayload) {
    referrer = await fastify.prisma.user.findUnique({
      where: { referralCode: referralPayload.trim().toUpperCase() },
      select: { id: true, referralCode: true, telegramId: true },
    });
  }

  let user: User;
  try {
    user = await fastify.prisma.user.create({
      data: {
        telegramId,
        referralCode: await generateUniqueReferralCode(fastify.prisma),
        referredByCode: referrer?.referralCode ?? undefined,
      },
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    // Lost a create race against a second concurrent launch for the same
    // brand-new telegramId — the other request's row is the real one; use it
    // rather than erroring out the user's first-ever open of the Mini App.
    return fastify.prisma.user.findUniqueOrThrow({ where: { telegramId } });
  }

  await fastify.prisma.auditLog.create({
    data: { userId: user.id, action: 'auth.telegram_register', ip: req.ip },
  });

  // Same trigger point as /auth/register above and the bot's own
  // resolveOrCreateUser: right after a new referred user is created.
  if (referrer) {
    const reward = await maybeActivateReferralReward(fastify.prisma, referrer.id);
    if (reward.activated && referrer.telegramId && fastify.config.TELEGRAM_BOT_TOKEN) {
      const bot = getReferralNotifierBot(fastify.config.TELEGRAM_BOT_TOKEN, fastify.log);
      await sendReferralRewardNotification(
        bot.api,
        referrer.telegramId,
        reward.referredCount,
        fastify.log as never,
      );
    }
  }

  return user;
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

    let referrer: { id: string; referralCode: string | null; telegramId: string | null } | null =
      null;
    if (body.referralCode) {
      referrer = await fastify.prisma.user.findUnique({
        where: { referralCode: body.referralCode.toUpperCase() },
        select: { id: true, referralCode: true, telegramId: true },
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

    // Same trigger point as the Telegram bot's resolveOrCreateUser: right after a new
    // referred user is created, since that's the one moment a referrer's count can change.
    if (referrer) {
      const reward = await maybeActivateReferralReward(fastify.prisma, referrer.id);
      if (reward.activated && referrer.telegramId && fastify.config.TELEGRAM_BOT_TOKEN) {
        const bot = getReferralNotifierBot(fastify.config.TELEGRAM_BOT_TOKEN, fastify.log);
        await sendReferralRewardNotification(
          bot.api,
          referrer.telegramId,
          reward.referredCount,
          fastify.log as never,
        );
      }
    }

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

  fastify.post('/auth/telegram', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply) => {
    if (!fastify.config.TELEGRAM_BOT_TOKEN) {
      return reply.code(503).send({ error: 'Telegram authentication is not configured' });
    }
    const body = telegramAuthSchema.parse(req.body);

    try {
      // Throws (SignatureMissingError/SignatureInvalidError/AuthDateInvalidError/
      // ExpiredError) on anything that isn't a genuine, fresh (default: <24h old,
      // see @tma.js/init-data-node's expiresIn default) initData signed by this
      // exact bot token — never trust the payload before this line succeeds.
      validateTelegramInitData(body.initData, fastify.config.TELEGRAM_BOT_TOKEN);
    } catch {
      return reply.code(401).send({ error: 'Invalid or expired Telegram authentication data' });
    }

    const parsed = parseTelegramInitData(body.initData);
    if (!parsed.user) {
      return reply.code(400).send({ error: 'initData has no user payload' });
    }
    const telegramId = parsed.user.id.toString();

    const user = await resolveOrCreateTelegramUser(fastify, req, telegramId, parsed.start_param);
    await fastify.prisma.auditLog.create({
      data: { userId: user.id, action: 'auth.telegram_login', ip: req.ip },
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
      isAdmin: isAdminUser(user, fastify.config.TELEGRAM_ADMIN_IDS),
      subscriptionTier: user.subscriptionTier,
      referralCode: user.referralCode,
    };
  });
}
