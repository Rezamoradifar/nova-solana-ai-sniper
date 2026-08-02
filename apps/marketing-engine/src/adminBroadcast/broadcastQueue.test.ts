import { describe, expect, it, vi } from 'vitest';
import { enqueueAdminBroadcast } from './broadcastQueue.js';

function fakePrisma(recipients: Array<{ id: string; telegramId: string }>) {
  const findMany = vi.fn().mockResolvedValue(recipients);
  const create = vi.fn().mockResolvedValue({ id: 'broadcast1' });
  const createMany = vi.fn().mockResolvedValue({ count: recipients.length });
  return {
    prisma: {
      user: { findMany },
      adminBroadcast: { create },
      adminBroadcastDelivery: { createMany },
    } as never,
    findMany,
    create,
    createMany,
  };
}

describe('enqueueAdminBroadcast', () => {
  it('queries only telegramId-linked, telegramActive users', async () => {
    const { prisma, findMany } = fakePrisma([]);
    await enqueueAdminBroadcast(prisma, 'hello');
    expect(findMany).toHaveBeenCalledWith({
      where: { telegramId: { not: null }, telegramActive: true },
      select: { id: true, telegramId: true },
    });
  });

  it('creates one AdminBroadcast row with the text and total recipient count', async () => {
    const recipients = [
      { id: 'u1', telegramId: 'c1' },
      { id: 'u2', telegramId: 'c2' },
    ];
    const { prisma, create } = fakePrisma(recipients);

    const result = await enqueueAdminBroadcast(prisma, 'hello world');

    expect(create).toHaveBeenCalledWith({
      data: { text: 'hello world', totalRecipients: 2 },
    });
    expect(result).toEqual({ broadcastId: 'broadcast1', recipientCount: 2 });
  });

  it('creates one AdminBroadcastDelivery row per recipient', async () => {
    const recipients = [
      { id: 'u1', telegramId: 'c1' },
      { id: 'u2', telegramId: 'c2' },
    ];
    const { prisma, createMany } = fakePrisma(recipients);

    await enqueueAdminBroadcast(prisma, 'hello world');

    expect(createMany).toHaveBeenCalledWith({
      data: [
        { broadcastId: 'broadcast1', userId: 'u1', telegramChatId: 'c1' },
        { broadcastId: 'broadcast1', userId: 'u2', telegramChatId: 'c2' },
      ],
    });
  });

  it('handles zero eligible recipients without creating delivery rows', async () => {
    const { prisma, createMany } = fakePrisma([]);
    const result = await enqueueAdminBroadcast(prisma, 'hello');
    expect(result.recipientCount).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });
});
