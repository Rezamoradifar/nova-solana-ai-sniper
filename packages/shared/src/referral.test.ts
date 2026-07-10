import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  maybeActivateReferralReward,
  REFERRAL_REWARD_AUDIT_ACTION,
  REFERRAL_REWARD_DEFAULT_BUY_AMOUNT_SOL,
  REFERRAL_REWARD_THRESHOLD,
} from './referral.js';

function fakePrisma(overrides: {
  referralCode?: string | null;
  referredCount?: number;
  alreadyRewarded?: boolean;
}) {
  const snipeConfigCreate = vi.fn().mockResolvedValue({ id: 'config-1' });
  const auditLogCreate = vi.fn().mockResolvedValue({ id: 'audit-1' });
  const prisma = {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          overrides.referralCode === undefined
            ? { referralCode: 'ABCD1234' }
            : { referralCode: overrides.referralCode },
        ),
      count: vi.fn().mockResolvedValue(overrides.referredCount ?? 0),
    },
    auditLog: {
      findFirst: vi
        .fn()
        .mockResolvedValue(overrides.alreadyRewarded ? { id: 'existing-audit' } : null),
      create: auditLogCreate,
    },
    snipeConfig: {
      create: snipeConfigCreate,
    },
    // Array-form $transaction: real Prisma calls each query method eagerly to build
    // the promises, then awaits them together — Promise.all mirrors that closely
    // enough for these tests to assert on the individual create() mocks below.
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { prisma: prisma as unknown as PrismaClient, snipeConfigCreate, auditLogCreate };
}

describe('maybeActivateReferralReward', () => {
  it('does nothing below the referral threshold', async () => {
    const { prisma, snipeConfigCreate, auditLogCreate } = fakePrisma({
      referredCount: REFERRAL_REWARD_THRESHOLD - 1,
    });

    const result = await maybeActivateReferralReward(prisma, 'user-1');

    expect(result).toEqual({ activated: false, referredCount: REFERRAL_REWARD_THRESHOLD - 1 });
    expect(snipeConfigCreate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it('activates a default sniper config once the threshold is reached', async () => {
    const { prisma, snipeConfigCreate, auditLogCreate } = fakePrisma({
      referredCount: REFERRAL_REWARD_THRESHOLD,
    });

    const result = await maybeActivateReferralReward(prisma, 'user-1');

    expect(result).toEqual({ activated: true, referredCount: REFERRAL_REWARD_THRESHOLD });
    expect(snipeConfigCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        buyAmountSol: REFERRAL_REWARD_DEFAULT_BUY_AMOUNT_SOL,
        autoBuyOnLaunch: true,
        isActive: true,
      },
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        action: REFERRAL_REWARD_AUDIT_ACTION,
        metadata: { referredCount: REFERRAL_REWARD_THRESHOLD },
      },
    });
  });

  it('activates when the referral count exceeds the threshold, not just exactly at it', async () => {
    const { prisma, snipeConfigCreate } = fakePrisma({
      referredCount: REFERRAL_REWARD_THRESHOLD + 5,
    });

    const result = await maybeActivateReferralReward(prisma, 'user-1');

    expect(result.activated).toBe(true);
    expect(snipeConfigCreate).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a user already rewarded does not get a second config', async () => {
    const { prisma, snipeConfigCreate, auditLogCreate } = fakePrisma({
      referredCount: REFERRAL_REWARD_THRESHOLD + 2,
      alreadyRewarded: true,
    });

    const result = await maybeActivateReferralReward(prisma, 'user-1');

    expect(result).toEqual({ activated: false, referredCount: REFERRAL_REWARD_THRESHOLD + 2 });
    expect(snipeConfigCreate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it('is a no-op for a user with no referral code at all', async () => {
    const { prisma, snipeConfigCreate } = fakePrisma({ referralCode: null });

    const result = await maybeActivateReferralReward(prisma, 'user-1');

    expect(result).toEqual({ activated: false, referredCount: 0 });
    expect(snipeConfigCreate).not.toHaveBeenCalled();
  });
});
