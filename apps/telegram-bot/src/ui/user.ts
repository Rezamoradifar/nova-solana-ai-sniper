import type { PrismaClient, User } from '@prisma/client';
import { generateUniqueReferralCode } from '@nova/shared';
import type { Context } from 'grammy';

/**
 * The bot is a standalone identity surface: a Telegram user gets an account
 * keyed by `telegramId` on first contact, independent of any email/password
 * account they may also have on the web dashboard. `referralPayload` is the
 * `/start <payload>` deep-link parameter (t.me/<bot>?start=<code>).
 */
export async function resolveOrCreateUser(
  prisma: PrismaClient,
  ctx: Context,
  referralPayload?: string,
): Promise<User> {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    throw new Error('Update has no ctx.from — cannot resolve a user');
  }

  const existing = await prisma.user.findUnique({ where: { telegramId } });
  if (existing) return existing;

  let referredByCode: string | undefined;
  if (referralPayload) {
    const referrer = await prisma.user.findUnique({
      where: { referralCode: referralPayload.trim().toUpperCase() },
      select: { referralCode: true },
    });
    referredByCode = referrer?.referralCode ?? undefined;
  }

  return prisma.user.create({
    data: {
      telegramId,
      referralCode: await generateUniqueReferralCode(prisma),
      referredByCode,
    },
  });
}
