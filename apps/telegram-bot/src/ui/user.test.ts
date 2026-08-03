import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Context } from 'grammy';
import type { Logger } from '@nova/shared';

const maybeActivateReferralReward = vi.fn();
vi.mock('@nova/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nova/shared')>();
  return { ...actual, maybeActivateReferralReward };
});

const sendReferralRewardNotification = vi.fn();
vi.mock('../notifications.js', () => ({ sendReferralRewardNotification }));

const { resolveOrCreateUser } = await import('./user.js');

const fakeLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger;

function fakeCtx(fromId: number): Context {
  return {
    from: { id: fromId },
    api: { sendMessage: vi.fn() },
  } as unknown as Context;
}

beforeEach(() => {
  maybeActivateReferralReward.mockReset();
  sendReferralRewardNotification.mockReset();
});

describe('resolveOrCreateUser', () => {
  it('returns the existing user untouched, without checking any referral reward', async () => {
    const existingUser = { id: 'user-1', telegramId: '111' };
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue(existingUser), create: vi.fn() },
    } as unknown as PrismaClient;

    const result = await resolveOrCreateUser({ prisma, logger: fakeLogger }, fakeCtx(111));

    expect(result).toBe(existingUser);
    expect(maybeActivateReferralReward).not.toHaveBeenCalled();
  });

  it('creates a new user with no referral payload and skips the reward check entirely', async () => {
    const created = { id: 'user-2', telegramId: '222' };
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
      },
    } as unknown as PrismaClient;

    const result = await resolveOrCreateUser({ prisma, logger: fakeLogger }, fakeCtx(222));

    expect(result).toBe(created);
    expect(maybeActivateReferralReward).not.toHaveBeenCalled();
  });

  it('checks the referrer for a reward when a new user joins via a referral code', async () => {
    const referrer = { id: 'referrer-1', referralCode: 'ABCD1234', telegramId: '999' };
    const created = { id: 'user-3', telegramId: '333' };
    const prisma = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null) // existing-user lookup by telegramId -> none
          .mockResolvedValueOnce(referrer), // referrer lookup by referralCode
        create: vi.fn().mockResolvedValue(created),
      },
    } as unknown as PrismaClient;
    maybeActivateReferralReward.mockResolvedValue({ activated: false, referredCount: 2 });

    await resolveOrCreateUser({ prisma, logger: fakeLogger }, fakeCtx(333), 'abcd1234');

    expect(maybeActivateReferralReward).toHaveBeenCalledWith(prisma, 'referrer-1');
    expect(sendReferralRewardNotification).not.toHaveBeenCalled();
  });

  it('notifies the referrer on Telegram when this referral crosses the reward threshold', async () => {
    const referrer = { id: 'referrer-1', referralCode: 'ABCD1234', telegramId: '999' };
    const created = { id: 'user-3', telegramId: '333' };
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(referrer),
        create: vi.fn().mockResolvedValue(created),
      },
    } as unknown as PrismaClient;
    maybeActivateReferralReward.mockResolvedValue({ activated: true, referredCount: 3 });
    const ctx = fakeCtx(333);

    await resolveOrCreateUser({ prisma, logger: fakeLogger }, ctx, 'ABCD1234');

    expect(sendReferralRewardNotification).toHaveBeenCalledWith(
      ctx.api,
      '999',
      3,
      fakeLogger,
      'en',
    );
  });

  it('does not attempt a Telegram notification if the newly-rewarded referrer has no telegramId', async () => {
    const referrer = { id: 'referrer-1', referralCode: 'ABCD1234', telegramId: null };
    const created = { id: 'user-3', telegramId: '333' };
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(referrer),
        create: vi.fn().mockResolvedValue(created),
      },
    } as unknown as PrismaClient;
    maybeActivateReferralReward.mockResolvedValue({ activated: true, referredCount: 3 });

    await resolveOrCreateUser({ prisma, logger: fakeLogger }, fakeCtx(333), 'ABCD1234');

    expect(sendReferralRewardNotification).not.toHaveBeenCalled();
  });
});
