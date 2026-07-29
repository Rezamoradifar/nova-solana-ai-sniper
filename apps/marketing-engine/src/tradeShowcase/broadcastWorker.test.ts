import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GrammyError } from 'grammy';
import { BroadcastWorker, type BroadcastWorkerDeps } from './broadcastWorker.js';

const resolveShowcaseTradeByPositionIdMock = vi.fn().mockResolvedValue(undefined);
const resolveTradePhotoMock = vi.fn().mockResolvedValue(undefined);
const sendTradeNotificationPhotoMock = vi.fn().mockResolvedValue({ message_id: 1 });

vi.mock('@nova/telegram-bot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nova/telegram-bot')>();
  return {
    ...actual,
    resolveTradePhoto: (...args: unknown[]) => resolveTradePhotoMock(...args),
    sendTradeNotificationPhoto: (...args: unknown[]) => sendTradeNotificationPhotoMock(...args),
  };
});

vi.mock('./data.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./data.js')>();
  return {
    ...actual,
    resolveShowcaseTradeByPositionId: (...args: unknown[]) =>
      resolveShowcaseTradeByPositionIdMock(...args),
  };
});

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
    createdAt: new Date('2026-07-29T00:00:00Z'),
    ...overrides,
  };
}

function fakeBroadcast(overrides: Record<string, unknown> = {}) {
  return {
    id: 'broadcast1',
    positionId: 'pos1',
    caption: 'CAPTION TEXT',
    photoFileId: 'existingFileId',
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
  const broadcastFindFirst = vi
    .fn()
    .mockResolvedValue(overrides.broadcast === undefined ? fakeBroadcast() : overrides.broadcast);
  const broadcastUpdate = vi.fn().mockResolvedValue(undefined);
  const deliveryFindMany = vi.fn().mockResolvedValue(overrides.deliveries ?? [fakeDelivery()]);
  const deliveryUpdate = vi.fn().mockResolvedValue(undefined);
  const deliveryCount = vi.fn().mockResolvedValue(0);
  const userUpdate = vi.fn().mockResolvedValue(undefined);

  return {
    deps: {
      prisma: {
        tradeBroadcast: { findFirst: broadcastFindFirst, update: broadcastUpdate },
        tradeBroadcastDelivery: {
          findMany: deliveryFindMany,
          update: deliveryUpdate,
          count: deliveryCount,
        },
        user: { update: userUpdate },
      },
      bot: {} as never,
      logger: fakeLogger(),
    } as unknown as BroadcastWorkerDeps,
    broadcastFindFirst,
    broadcastUpdate,
    deliveryFindMany,
    deliveryUpdate,
    deliveryCount,
    userUpdate,
  };
}

describe('BroadcastWorker.tick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveShowcaseTradeByPositionIdMock.mockResolvedValue(undefined);
    resolveTradePhotoMock.mockResolvedValue(undefined);
    sendTradeNotificationPhotoMock.mockResolvedValue({ message_id: 1 });
  });

  it('does nothing when there is no pending or in-progress broadcast', async () => {
    const { deps, deliveryFindMany } = fakeDeps({ broadcast: null });
    const worker = new BroadcastWorker(deps);

    await worker.tick();

    expect(deliveryFindMany).not.toHaveBeenCalled();
  });

  it('sends every eligible PENDING delivery and marks it SENT, then completes the broadcast', async () => {
    const { deps, deliveryFindMany, deliveryUpdate, broadcastUpdate, deliveryCount } = fakeDeps({
      deliveries: [fakeDelivery()],
    });
    // Drain the batch loop after one findMany call returning work, then empty.
    deliveryFindMany.mockResolvedValueOnce([fakeDelivery()]).mockResolvedValueOnce([]);
    deliveryCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0); // remaining=0, failed=0

    const worker = new BroadcastWorker(deps);
    await worker.tick();

    expect(sendTradeNotificationPhotoMock).toHaveBeenCalledWith(deps.bot, 'chat1', 'CAPTION TEXT', {
      fileId: 'existingFileId',
    });
    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delivery1' },
        data: expect.objectContaining({ status: 'SENT' }),
      }),
    );
    expect(broadcastUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'broadcast1' },
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
  });

  it('marks a PENDING broadcast IN_PROGRESS before processing it', async () => {
    const { deps, broadcastUpdate, deliveryFindMany, deliveryCount } = fakeDeps({
      deliveries: [],
    });
    deliveryFindMany.mockResolvedValue([]);
    deliveryCount.mockResolvedValue(0);

    const worker = new BroadcastWorker(deps);
    await worker.tick();

    expect(broadcastUpdate).toHaveBeenCalledWith({
      where: { id: 'broadcast1' },
      data: { status: 'IN_PROGRESS' },
    });
  });

  it('on a permanent Telegram error, marks the delivery FAILED_PERMANENT and the user telegramActive:false', async () => {
    const err = new GrammyError(
      'Forbidden',
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      'sendPhoto',
      {},
    );
    sendTradeNotificationPhotoMock.mockRejectedValueOnce(err);
    const { deps, deliveryUpdate, userUpdate, broadcastUpdate, deliveryFindMany, deliveryCount } =
      fakeDeps({ deliveries: [fakeDelivery()] });
    deliveryFindMany.mockResolvedValueOnce([fakeDelivery()]).mockResolvedValueOnce([]);
    deliveryCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1); // remaining=0, failed=1

    const worker = new BroadcastWorker(deps);
    await worker.tick();

    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delivery1' },
        data: expect.objectContaining({ status: 'FAILED_PERMANENT' }),
      }),
    );
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user1' },
      data: { telegramActive: false },
    });
    expect(broadcastUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETED_WITH_FAILURES' }),
      }),
    );
  });

  it('on a transient error, leaves the delivery PENDING with attempts incremented (retries later)', async () => {
    sendTradeNotificationPhotoMock.mockRejectedValueOnce(new Error('network blip'));
    const { deps, deliveryUpdate, deliveryFindMany, deliveryCount } = fakeDeps({
      deliveries: [fakeDelivery({ attempts: 0 })],
    });
    deliveryFindMany
      .mockResolvedValueOnce([fakeDelivery({ attempts: 0 })])
      .mockResolvedValueOnce([]);
    deliveryCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0); // remaining=1 -> broadcast left mid-flight

    const worker = new BroadcastWorker(deps);
    await worker.tick();

    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delivery1' },
        data: expect.objectContaining({ status: 'PENDING', attempts: 1 }),
      }),
    );
  });

  it('marks a delivery FAILED_TEMP once it exhausts MAX_TRANSIENT_ATTEMPTS', async () => {
    sendTradeNotificationPhotoMock.mockRejectedValueOnce(new Error('still failing'));
    const { deps, deliveryUpdate, deliveryFindMany, deliveryCount } = fakeDeps({
      deliveries: [fakeDelivery({ attempts: 4 })],
    });
    deliveryFindMany
      .mockResolvedValueOnce([fakeDelivery({ attempts: 4 })])
      .mockResolvedValueOnce([]);
    deliveryCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const worker = new BroadcastWorker(deps);
    await worker.tick();

    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delivery1' },
        data: expect.objectContaining({ status: 'FAILED_TEMP', attempts: 5 }),
      }),
    );
  });

  it('skips a delivery still inside its retry backoff window and stops the batch loop', async () => {
    const recentlyAttempted = fakeDelivery({
      attempts: 1,
      lastAttemptAt: new Date(), // "now" — well inside the 30s base backoff
    });
    const { deps, deliveryFindMany, deliveryUpdate } = fakeDeps({
      deliveries: [recentlyAttempted],
    });
    deliveryFindMany.mockResolvedValue([recentlyAttempted]);

    const worker = new BroadcastWorker(deps);
    await worker.tick();

    expect(sendTradeNotificationPhotoMock).not.toHaveBeenCalled();
    expect(deliveryUpdate).not.toHaveBeenCalled();
  });

  it('re-resolves the trade photo from the position when no photoFileId is cached yet', async () => {
    const { deps, deliveryFindMany, deliveryCount } = fakeDeps({
      broadcast: fakeBroadcast({ photoFileId: null }),
      deliveries: [],
    });
    deliveryFindMany.mockResolvedValue([]);
    deliveryCount.mockResolvedValue(0);
    resolveShowcaseTradeByPositionIdMock.mockResolvedValue({
      id: 'pos1',
      token: { symbol: 'EXT' },
    });

    const worker = new BroadcastWorker(deps);
    await worker.tick();

    expect(resolveShowcaseTradeByPositionIdMock).toHaveBeenCalledWith(deps.prisma, 'pos1');
    expect(resolveTradePhotoMock).toHaveBeenCalled();
  });

  it('guards against overlapping ticks while a broadcast is still processing', async () => {
    const { deps, broadcastFindFirst } = fakeDeps({ deliveries: [] });
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    broadcastFindFirst.mockImplementationOnce(async () => {
      await gate;
      return null;
    });

    const worker = new BroadcastWorker(deps);
    const first = worker.tick();
    const second = worker.tick();
    releaseFirst();
    await Promise.all([first, second]);

    expect(broadcastFindFirst).toHaveBeenCalledTimes(1);
  });
});
