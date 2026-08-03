import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GrammyError } from 'grammy';
import { NetworkTradeBroadcastWorker } from './broadcastWorker.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery1',
    broadcastId: 'broadcast1',
    userId: 'user1',
    telegramChatId: 'chat1',
    status: 'PENDING',
    attempts: 0,
    lastAttemptAt: null,
    createdAt: new Date('2026-08-03T00:00:00Z'),
    ...overrides,
  };
}

function fakeBroadcast(overrides: Record<string, unknown> = {}) {
  return {
    id: 'broadcast1',
    entryId: 'entry1',
    caption: 'CAPTION TEXT',
    photoFileId: 'existingFileId',
    buttonsJson: '[[{"text":"Buy","url":"https://example.com/buy"}]]',
    status: 'PENDING',
    ...overrides,
  };
}

function fakeDeps(
  overrides: {
    broadcast?: unknown;
    deliveries?: unknown[];
  } = {},
) {
  const broadcast = overrides.broadcast ?? fakeBroadcast();
  const deliveries = overrides.deliveries ?? [fakeDelivery()];
  let remainingDeliveries = [...deliveries];

  const findFirst = vi.fn().mockImplementation(() => Promise.resolve(broadcast));
  const findMany = vi.fn().mockImplementation(() => {
    const pending = remainingDeliveries.filter(
      (d: unknown) => (d as { status: string }).status === 'PENDING',
    );
    return Promise.resolve(pending);
  });
  const deliveryUpdate = vi
    .fn()
    .mockImplementation(
      ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        remainingDeliveries = remainingDeliveries.map((d: unknown) =>
          (d as { id: string }).id === where.id ? { ...(d as object), ...data } : d,
        );
        return Promise.resolve(undefined);
      },
    );
  const broadcastUpdate = vi.fn().mockResolvedValue(undefined);
  const userUpdate = vi.fn().mockResolvedValue(undefined);
  const deliveryCount = vi.fn().mockImplementation(({ where }: { where: { status: unknown } }) => {
    const status = where.status as string | { in: string[] };
    const statuses = typeof status === 'string' ? [status] : status.in;
    return Promise.resolve(
      remainingDeliveries.filter((d: unknown) =>
        statuses.includes((d as { status: string }).status),
      ).length,
    );
  });

  const sendPhoto = vi.fn().mockResolvedValue({ message_id: 1 });
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

  return {
    prisma: {
      networkTradeBroadcast: { findFirst, update: broadcastUpdate },
      networkTradeBroadcastDelivery: {
        findMany,
        update: deliveryUpdate,
        count: deliveryCount,
      },
      user: { update: userUpdate },
    },
    bot: { api: { sendPhoto, sendMessage } },
    logger: fakeLogger(),
  } as never;
}

function bot(deps: unknown) {
  return (
    deps as {
      bot: { api: { sendPhoto: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> } };
    }
  ).bot.api;
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('NetworkTradeBroadcastWorker', () => {
  it('sends the exact fileId/caption/buttons to every pending delivery and marks the broadcast COMPLETED', async () => {
    const deps = fakeDeps({
      deliveries: [
        fakeDelivery({ id: 'd1', telegramChatId: 'chat1' }),
        fakeDelivery({ id: 'd2', telegramChatId: 'chat2' }),
      ],
    });
    const worker = new NetworkTradeBroadcastWorker(deps);

    await worker.tick();

    expect(bot(deps).sendPhoto).toHaveBeenCalledTimes(2);
    const [chatId, source, opts] = bot(deps).sendPhoto.mock.calls[0]!;
    expect(chatId).toBe('chat1');
    expect(source).toBe('existingFileId');
    expect(opts.caption).toBe('CAPTION TEXT');
    expect(opts.parse_mode).toBe('HTML');
    expect(opts.reply_markup).toBeDefined();

    const broadcastUpdateCalls = (
      deps as { prisma: { networkTradeBroadcast: { update: ReturnType<typeof vi.fn> } } }
    ).prisma.networkTradeBroadcast.update.mock.calls;
    const finalCall = broadcastUpdateCalls[broadcastUpdateCalls.length - 1]![0];
    expect(finalCall.data.status).toBe('COMPLETED');
  });

  it('marks a permanently-failed delivery FAILED_PERMANENT and the user telegramActive:false, without retrying it', async () => {
    const sendPhoto = vi
      .fn()
      .mockRejectedValue(
        new GrammyError(
          'Forbidden',
          { error_code: 403, description: 'Forbidden: bot was blocked by the user' } as never,
          'sendPhoto',
          {} as never,
        ),
      );
    const deps = fakeDeps({ deliveries: [fakeDelivery({ id: 'd1' })] });
    (deps as { bot: { api: { sendPhoto: unknown } } }).bot.api.sendPhoto = sendPhoto;
    const worker = new NetworkTradeBroadcastWorker(deps);

    await worker.tick();

    const userUpdate = (deps as { prisma: { user: { update: ReturnType<typeof vi.fn> } } }).prisma
      .user.update;
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user1' },
      data: { telegramActive: false },
    });
  });

  it('does nothing when there is no PENDING/IN_PROGRESS broadcast', async () => {
    const deps = fakeDeps({ broadcast: null, deliveries: [] });
    const worker = new NetworkTradeBroadcastWorker(deps);

    await worker.tick();

    expect(bot(deps).sendPhoto).not.toHaveBeenCalled();
  });
});
