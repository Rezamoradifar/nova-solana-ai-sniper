import { describe, expect, it, vi } from 'vitest';
import { isAdminUser, requireAdminUser } from './adminAccess.js';

describe('isAdminUser', () => {
  it('accepts a DB ADMIN role', () => {
    expect(isAdminUser({ role: 'ADMIN', telegramId: null }, undefined)).toBe(true);
  });
  it('accepts a Telegram id listed in TELEGRAM_ADMIN_IDS', () => {
    expect(
      isAdminUser({ role: 'TRADER', telegramId: '5138248422' }, '8342123215, 5138248422'),
    ).toBe(true);
  });
  it('rejects anyone else', () => {
    expect(isAdminUser({ role: 'TRADER', telegramId: '111' }, '8342123215')).toBe(false);
    expect(isAdminUser({ role: 'TRADER', telegramId: null }, '8342123215')).toBe(false);
    expect(isAdminUser({ role: 'TRADER', telegramId: '111' }, undefined)).toBe(false);
  });
});

function fakeReq(user: { role: string; telegramId: string | null } | null, jwtOk = true) {
  return {
    jwtVerify: vi.fn(jwtOk ? async () => undefined : async () => Promise.reject(new Error('bad'))),
    user: { userId: 'u1' },
    server: {
      prisma: { user: { findUnique: vi.fn().mockResolvedValue(user) } },
      config: { TELEGRAM_ADMIN_IDS: '8342123215' },
    },
  };
}
function fakeReply() {
  const reply = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  return reply;
}

describe('requireAdminUser', () => {
  it('lets an admin through without replying', async () => {
    const reply = fakeReply();
    await requireAdminUser(
      fakeReq({ role: 'TRADER', telegramId: '8342123215' }) as never,
      reply as never,
    );
    expect(reply.code).not.toHaveBeenCalled();
  });
  it('returns 403 for a signed-in non-admin', async () => {
    const reply = fakeReply();
    await requireAdminUser(fakeReq({ role: 'TRADER', telegramId: '999' }) as never, reply as never);
    expect(reply.code).toHaveBeenCalledWith(403);
  });
  it('returns 401 for an invalid token', async () => {
    const reply = fakeReply();
    await requireAdminUser(fakeReq(null, false) as never, reply as never);
    expect(reply.code).toHaveBeenCalledWith(401);
  });
});
