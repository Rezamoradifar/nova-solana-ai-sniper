import type { User } from '@prisma/client';
import { generateUniqueReferralCode, maybeActivateReferralReward } from '@nova/shared';
import type { Context } from 'grammy';
import { sendReferralRewardNotification } from '../notifications.js';
import type { ScreenDeps } from './types.js';

/**
 * The bot is a standalone identity surface: a Telegram user gets an account
 * keyed by `telegramId` on first contact, independent of any email/password
 * account they may also have on the web dashboard. `referralPayload` is the
 * `/start <payload>` deep-link parameter (t.me/<bot>?start=<code>).
 */
export async function resolveOrCreateUser(
  deps: Pick<ScreenDeps, 'prisma' | 'logger'>,
  ctx: Context,
  referralPayload?: string,
): Promise<User> {
  const { prisma, logger } = deps;
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    throw new Error('Update has no ctx.from — cannot resolve a user');
  }

  const existing = await prisma.user.findUnique({ where: { telegramId } });
  if (existing) return existing;

  let referrer: { id: string; referralCode: string | null; telegramId: string | null } | null =
    null;
  if (referralPayload) {
    referrer = await prisma.user.findUnique({
      where: { referralCode: referralPayload.trim().toUpperCase() },
      select: { id: true, referralCode: true, telegramId: true },
    });
  }

  const created = await prisma.user.create({
    data: {
      telegramId,
      referralCode: await generateUniqueReferralCode(prisma),
      referredByCode: referrer?.referralCode ?? undefined,
    },
  });

  // Fires on the referral that completes the threshold — checked here (right after a
  // new referred user is created) rather than on every screen render, since this is
  // the one moment a referrer's count can actually change.
  if (referrer) {
    const reward = await maybeActivateReferralReward(prisma, referrer.id);
    if (reward.activated && referrer.telegramId) {
      await sendReferralRewardNotification(
        ctx.api,
        referrer.telegramId,
        reward.referredCount,
        logger,
      );
    }
  }

  return created;
}
