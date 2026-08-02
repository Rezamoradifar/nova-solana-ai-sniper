import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GrammyError } from 'grammy';
import { AdminBroadcastWorker, type AdminBroadcastWorkerDeps } from './adminBroadcastWorker.js';

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
    createdAt: new Date('2026-07-31T00:00:00Z'),
    ...overrides,
  };
}

function fakeBroadcast(overrides: Record<string, unknown> = {}) {
  return {
    id: 'broadcast1',
    text: 'ANNOUNCEMENT TEXT',
    status: 'PENDING',
    ...overrides,
  };
}

function fakeDeps(
  overrides: {
    broadcast?: unknown;
    deliveries?: unknown[];
    sendMessage?: ReturnType<typeof vi.fn>;
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
  const sendMessage = overrides.sendMessage ?? vi.fn().mockResolvedValue({ message_id: 1 });

  return {
    deps: {
      prisma: {
        adminBroadcast: { findFirst: broadcastFindFirst, update: broadcastUpdate },
        adminBroadcastDelivery: {
          findMany: deliveryFindMany,
          update: deliveryUpdate,
          count: deliveryCount,
        },
        user: { update: userUpdate },
      },
      bot: { api: { sendMessage } },
      logger: fakeLogger(),
    } as unknown as AdminBroadcastWorkerDeps,
    broadcastFindFirst,
    broadcastUpdate,
    deliveryFindMany,
    deliveryUpdate,
    deliveryCount,
    userUpdate,
    sendMessage,
  };
}

describe('AdminBroadcastWorker.tick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when there is no pending or in-progress broadcast', async () => {
    const { deps, deliveryFindMany } = fakeDeps({ broadcast: null });
    const worker = new AdminBroadcastWorker(deps);

    await worker.tick();

    expect(deliveryFindMany).not.toHaveBeenCalled();
  });

  it('sends every eligible PENDING delivery with no parse_mode, marks it SENT, then completes the broadcast', async () => {
    const { deps, deliveryFindMany, deliveryUpdate, broadcastUpdate, deliveryCount, sendMessage } =
      fakeDeps({ deliveries: [fakeDelivery()] });
    deliveryFindMany.mockResolvedValueOnce([fakeDelivery()]).mockResolvedValueOnce([]);
    deliveryCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const worker = new AdminBroadcastWorker(deps);
    await worker.tick();

    expect(sendMessage).toHaveBeenCalledWith('chat1', 'ANNOUNCEMENT TEXT');
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
    const { deps, broadcastUpdate, deliveryFindMany, deliveryCount } = fakeDeps({ deliveries: [] });
    deliveryFindMany.mockResolvedValue([]);
    deliveryCount.mockResolvedValue(0);

    const worker = new AdminBroadcastWorker(deps);
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
      'sendMessage',
      {},
    );
    const sendMessage = vi.fn().mockRejectedValueOnce(err);
    const { deps, deliveryUpdate, userUpdate, broadcastUpdate, deliveryFindMany, deliveryCount } =
      fakeDeps({ deliveries: [fakeDelivery()], sendMessage });
    deliveryFindMany.mockResolvedValueOnce([fakeDelivery()]).mockResolvedValueOnce([]);
    deliveryCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const worker = new AdminBroadcastWorker(deps);
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
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('network blip'));
    const { deps, deliveryUpdate, deliveryFindMany, deliveryCount } = fakeDeps({
      deliveries: [fakeDelivery({ attempts: 0 })],
      sendMessage,
    });
    deliveryFindMany
      .mockResolvedValueOnce([fakeDelivery({ attempts: 0 })])
      .mockResolvedValueOnce([]);
    deliveryCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const worker = new AdminBroadcastWorker(deps);
    await worker.tick();

    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delivery1' },
        data: expect.objectContaining({ status: 'PENDING', attempts: 1 }),
      }),
    );
  });

  it('marks a delivery FAILED_TEMP once it exhausts MAX_TRANSIENT_ATTEMPTS', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('still failing'));
    const { deps, deliveryUpdate, deliveryFindMany, deliveryCount } = fakeDeps({
      deliveries: [fakeDelivery({ attempts: 4 })],
      sendMessage,
    });
    deliveryFindMany
      .mockResolvedValueOnce([fakeDelivery({ attempts: 4 })])
      .mockResolvedValueOnce([]);
    deliveryCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const worker = new AdminBroadcastWorker(deps);
    await worker.tick();

    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delivery1' },
        data: expect.objectContaining({ status: 'FAILED_TEMP', attempts: 5 }),
      }),
    );
  });

  it('skips a delivery still inside its retry backoff window and stops the batch loop', async () => {
    const recentlyAttempted = fakeDelivery({ attempts: 1, lastAttemptAt: new Date() });
    const { deps, deliveryFindMany, deliveryUpdate, sendMessage } = fakeDeps({
      deliveries: [recentlyAttempted],
    });
    deliveryFindMany.mockResolvedValue([recentlyAttempted]);

    const worker = new AdminBroadcastWorker(deps);
    await worker.tick();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(deliveryUpdate).not.toHaveBeenCalled();
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

    const worker = new AdminBroadcastWorker(deps);
    const first = worker.tick();
    const second = worker.tick();
    releaseFirst();
    await Promise.all([first, second]);

    expect(broadcastFindFirst).toHaveBeenCalledTimes(1);
  });
});
