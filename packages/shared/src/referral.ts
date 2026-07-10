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
