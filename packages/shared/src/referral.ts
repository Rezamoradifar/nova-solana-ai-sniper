import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

// Excludes ambiguous characters (0/O, 1/I) so codes are easy to read and retype.
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_LENGTH = 8;

function randomReferralCode(): string {
  const bytes = randomBytes(REFERRAL_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += REFERRAL_CODE_ALPHABET[bytes[i]! % REFERRAL_CODE_ALPHABET.length];
  }
  return code;
}

/** Generates a referral code, retrying on the astronomically unlikely collision. */
export async function generateUniqueReferralCode(prisma: PrismaClient): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomReferralCode();
    const existing = await prisma.user.findUnique({ where: { referralCode: code } });
    if (!existing) return code;
  }
  throw new Error('Failed to generate a unique referral code');
}

/** Referrals needed before a referrer gets a default sniper config activated for them. */
export const REFERRAL_REWARD_THRESHOLD = 3;
/**
 * AuditLog action written the moment a referrer is rewarded — also the key used to
 * make maybeActivateReferralReward idempotent (its presence means "already rewarded").
 * Matches the pre-existing label in apps/telegram-bot/src/ui/screens/alerts.ts.
 */
export const REFERRAL_REWARD_AUDIT_ACTION = 'referral.pro_unlocked';
// Must match apps/telegram-bot/src/ui/screens/sniper.ts's DEFAULT_BUY_AMOUNT_SOL —
// duplicated here (rather than imported) because packages/shared can't depend on an app.
export const REFERRAL_REWARD_DEFAULT_BUY_AMOUNT_SOL = 0.1;

export interface ReferralRewardResult {
  activated: boolean;
  referredCount: number;
}

/**
 * Checks whether a referrer has crossed REFERRAL_REWARD_THRESHOLD and, if so and not
 * already rewarded, activates a default auto-buy sniper config for them (same shape
 * as the bot's own Quick-Start). Idempotent via the AuditLog action above, so it's
 * safe to call on every new referral registration and safe to re-run in a backfill —
 * a second crossing (e.g. a 4th, 5th referral) is a no-op, not a second config.
 */
export async function maybeActivateReferralReward(
  prisma: PrismaClient,
  referrerId: string,
): Promise<ReferralRewardResult> {
  const referrer = await prisma.user.findUnique({
    where: { id: referrerId },
    select: { referralCode: true },
  });
  if (!referrer?.referralCode) return { activated: false, referredCount: 0 };

  const referredCount = await prisma.user.count({
    where: { referredByCode: referrer.referralCode },
  });
  if (referredCount < REFERRAL_REWARD_THRESHOLD) return { activated: false, referredCount };

  const alreadyRewarded = await prisma.auditLog.findFirst({
    where: { userId: referrerId, action: REFERRAL_REWARD_AUDIT_ACTION },
    select: { id: true },
  });
  if (alreadyRewarded) return { activated: false, referredCount };

  await prisma.$transaction([
    prisma.snipeConfig.create({
      data: {
        userId: referrerId,
        buyAmountSol: REFERRAL_REWARD_DEFAULT_BUY_AMOUNT_SOL,
        autoBuyOnLaunch: true,
        isActive: true,
      },
    }),
    prisma.auditLog.create({
      data: {
        userId: referrerId,
        action: REFERRAL_REWARD_AUDIT_ACTION,
        metadata: { referredCount },
      },
    }),
  ]);

  return { activated: true, referredCount };
}
