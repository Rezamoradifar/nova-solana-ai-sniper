import { describe, expect, it, vi } from 'vitest';
import { enqueueNetworkTradeBroadcast } from './broadcastQueue.js';

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    user: { findMany: vi.fn().mockResolvedValue([]) },
    networkTradeBroadcast: { create: vi.fn() },
    networkTradeBroadcastDelivery: { createMany: vi.fn() },
    ...overrides,
  } as never;
}

describe('enqueueNetworkTradeBroadcast', () => {
  it('creates one broadcast row and one delivery row per active telegram user', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'u1', telegramId: 'chat1' },
      { id: 'u2', telegramId: 'chat2' },
    ]);
    const create = vi.fn().mockResolvedValue({ id: 'broadcast1' });
    const createMany = vi.fn().mockResolvedValue(undefined);
    const prisma = fakePrisma({
      user: { findMany },
      networkTradeBroadcast: { create },
      networkTradeBroadcastDelivery: { createMany },
    });

    const result = await enqueueNetworkTradeBroadcast(
      prisma,
      'entry1',
      'CAPTION',
      'fileId123',
      '[]',
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { telegramId: { not: null }, telegramActive: true },
      select: { id: true, telegramId: true },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        entryId: 'entry1',
        caption: 'CAPTION',
        photoFileId: 'fileId123',
        buttonsJson: '[]',
        totalRecipients: 2,
      },
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { broadcastId: 'broadcast1', userId: 'u1', telegramChatId: 'chat1' },
        { broadcastId: 'broadcast1', userId: 'u2', telegramChatId: 'chat2' },
      ],
    });
    expect(result).toEqual({ broadcastId: 'broadcast1', recipientCount: 2 });
  });

  it('creates a zero-recipient broadcast row (no delivery rows) when no users are eligible', async () => {
    const createMany = vi.fn();
    const create = vi.fn().mockResolvedValue({ id: 'broadcast1' });
    const prisma = fakePrisma({
      networkTradeBroadcast: { create },
      networkTradeBroadcastDelivery: { createMany },
    });

    const result = await enqueueNetworkTradeBroadcast(prisma, 'entry1', 'CAPTION', 'fileId', '[]');

    expect(result.recipientCount).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });
});
