import { describe, expect, it, vi } from 'vitest';
import { sign, validate, parse } from '@tma.js/init-data-node';
import { telegramAuthSchema, resolveOrCreateTelegramUser } from './auth.js';

const BOT_TOKEN = '123456:AAFakeBotTokenForTestsOnlyNotARealSecret';

/** Builds a genuinely validly-signed initData string using the same library
 * the route verifies with — so these tests exercise real HMAC signing/
 * verification, not a stubbed-out version of it. */
function signedInitData(
  overrides: { userId?: number; startParam?: string } = {},
  botToken = BOT_TOKEN,
): string {
  return sign(
    {
      user: {
        id: overrides.userId ?? 999000111,
        first_name: 'Test',
        last_name: 'User',
      },
      start_param: overrides.startParam,
    },
    botToken,
    new Date(),
  );
}

describe('telegramAuthSchema', () => {
  it('accepts a non-empty initData string', () => {
    expect(telegramAuthSchema.safeParse({ initData: 'abc' }).success).toBe(true);
  });

  it('rejects an empty or missing initData', () => {
    expect(telegramAuthSchema.safeParse({ initData: '' }).success).toBe(false);
    expect(telegramAuthSchema.safeParse({}).success).toBe(false);
  });
});

describe('validate()/parse() usage (real HMAC signing+verification, not mocked)', () => {
  it('accepts initData signed with the matching bot token', () => {
    const initData = signedInitData();
    expect(() => validate(initData, BOT_TOKEN)).not.toThrow();
  });

  it('rejects initData signed with a different bot token — the exact case that must produce a 401', () => {
    const initData = signedInitData({}, 'other-bot-token');
    expect(() => validate(initData, BOT_TOKEN)).toThrow();
  });

  it('rejects tampered initData (payload changed after signing)', () => {
    const initData = signedInitData();
    const tampered = initData.replace(/first_name%22%3A%22Test/, 'first_name%22%3A%22Evil');
    expect(() => validate(tampered, BOT_TOKEN)).toThrow();
  });

  it('parse() recovers the same user id and start_param that were signed', () => {
    const initData = signedInitData({ userId: 42, startParam: 'REF123' });
    const parsed = parse(initData);
    expect(parsed.user?.id).toBe(42);
    expect(parsed.start_param).toBe('REF123');
  });
});

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

describe('resolveOrCreateTelegramUser', () => {
  it('returns the existing user by telegramId without creating a new one', async () => {
    const existingUser = { id: 'user-1', telegramId: '999', role: 'TRADER' };
    const prisma = fakePrisma({
      user: {
        findUnique: vi.fn().mockResolvedValue(existingUser),
        create: vi.fn(),
      },
    });
    const fastify = { prisma, config: {}, log: { warn: vi.fn(), error: vi.fn() } } as never;

    const result = await resolveOrCreateTelegramUser(fastify, { ip: '1.2.3.4' }, '999', undefined);

    expect(result).toBe(existingUser);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('creates a new user by telegramId when none exists, and logs the audit event', async () => {
    const newUser = { id: 'user-2', telegramId: '888', role: 'TRADER' };
    const prisma = fakePrisma({
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(newUser),
      },
    });
    const fastify = { prisma, config: {}, log: { warn: vi.fn(), error: vi.fn() } } as never;

    const result = await resolveOrCreateTelegramUser(fastify, { ip: '1.2.3.4' }, '888', undefined);

    expect(result).toBe(newUser);
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ telegramId: '888' }) }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-2', action: 'auth.telegram_register' }),
      }),
    );
  });

  it('recovers from a create-race unique-constraint error by re-reading the row the other request created', async () => {
    const winnerUser = { id: 'user-3', telegramId: '777', role: 'TRADER' };
    const prisma = fakePrisma({
      user: {
        findUnique: vi.fn().mockResolvedValue(null), // both racers see "not found" first
        create: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('unique constraint'), { code: 'P2002' })),
        findUniqueOrThrow: vi.fn().mockResolvedValue(winnerUser),
      },
    });
    const fastify = { prisma, config: {}, log: { warn: vi.fn(), error: vi.fn() } } as never;

    const result = await resolveOrCreateTelegramUser(fastify, { ip: '1.2.3.4' }, '777', undefined);

    expect(result).toBe(winnerUser);
  });

  it('re-throws a create failure that is not a unique-constraint race', async () => {
    const prisma = fakePrisma({
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(new Error('database is down')),
      },
    });
    const fastify = { prisma, config: {}, log: { warn: vi.fn(), error: vi.fn() } } as never;

    await expect(
      resolveOrCreateTelegramUser(fastify, { ip: '1.2.3.4' }, '555', undefined),
    ).rejects.toThrow('database is down');
  });

  it('links a new user to a referrer found by start_param', async () => {
    const referrer = { id: 'referrer-1', referralCode: 'ABCD', telegramId: '111' };
    const newUser = { id: 'user-4', telegramId: '666', role: 'TRADER' };
    // 'ABCD' is the one referral code this test cares about; every other
    // referralCode lookup is generateUniqueReferralCode's own internal
    // uniqueness check for the brand-new user's generated code, which must
    // see "not taken" (null) or the whole call fails after 5 retries.
    const findUnique = vi.fn().mockImplementation(({ where }) => {
      if (where.telegramId) return Promise.resolve(null);
      if (where.referralCode === 'ABCD') return Promise.resolve(referrer);
      return Promise.resolve(null);
    });
    const prisma = fakePrisma({
      user: { findUnique, create: vi.fn().mockResolvedValue(newUser) },
    });
    const fastify = { prisma, config: {}, log: { warn: vi.fn(), error: vi.fn() } } as never;

    await resolveOrCreateTelegramUser(fastify, { ip: '1.2.3.4' }, '666', 'abcd');

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ referredByCode: 'ABCD' }) }),
    );
  });

  it('never links a referrer when no start_param was provided', async () => {
    const prisma = fakePrisma({
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'user-5', role: 'TRADER' }),
      },
    });
    const fastify = { prisma, config: {}, log: { warn: vi.fn(), error: vi.fn() } } as never;

    await resolveOrCreateTelegramUser(fastify, { ip: '1.2.3.4' }, '444', undefined);

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ referredByCode: undefined }) }),
    );
  });
});
