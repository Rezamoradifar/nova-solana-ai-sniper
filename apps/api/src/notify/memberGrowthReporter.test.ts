import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemberGrowthReporter } from './memberGrowthReporter.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakePrisma(overrides: {
  userCount: number;
  stats: { lastNotifiedCount: number; lastMilestone: number } | null;
}) {
  const create = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  return {
    prisma: {
      user: { count: vi.fn().mockResolvedValue(overrides.userCount) },
      botMemberStats: {
        findUnique: vi.fn().mockResolvedValue(overrides.stats),
        create,
        update,
      },
    } as never,
    create,
    update,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MemberGrowthReporter', () => {
  it('on the very first run, establishes a baseline without sending any notification', async () => {
    const notifyMemberGrowth = vi.fn().mockResolvedValue(undefined);
    const notifyMemberMilestone = vi.fn().mockResolvedValue(undefined);
    const { prisma, create } = fakePrisma({ userCount: 2541, stats: null });
    const reporter = new MemberGrowthReporter(
      prisma,
      { notifyMemberGrowth, notifyMemberMilestone } as never,
      fakeLogger(),
    );

    await reporter.reportOnce();

    expect(notifyMemberGrowth).not.toHaveBeenCalled();
    expect(notifyMemberMilestone).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      data: { id: 'bot_member_stats', lastNotifiedCount: 2541, lastMilestone: 1000 },
    });
  });

  it('sends a single batched growth notification for multiple joins since the last poll', async () => {
    const notifyMemberGrowth = vi.fn().mockResolvedValue(undefined);
    const notifyMemberMilestone = vi.fn().mockResolvedValue(undefined);
    const { prisma, update } = fakePrisma({
      userCount: 2546,
      stats: { lastNotifiedCount: 2541, lastMilestone: 1000 },
    });
    const reporter = new MemberGrowthReporter(
      prisma,
      { notifyMemberGrowth, notifyMemberMilestone } as never,
      fakeLogger(),
    );

    await reporter.reportOnce();

    expect(notifyMemberGrowth).toHaveBeenCalledTimes(1);
    expect(notifyMemberGrowth).toHaveBeenCalledWith({ newCount: 5, totalMembers: 2546 });
    expect(notifyMemberMilestone).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'bot_member_stats' },
      data: { lastNotifiedCount: 2546, lastMilestone: 1000 },
    });
  });

  it('sends a milestone notification once a threshold is newly crossed', async () => {
    const notifyMemberGrowth = vi.fn().mockResolvedValue(undefined);
    const notifyMemberMilestone = vi.fn().mockResolvedValue(undefined);
    const { prisma, update } = fakePrisma({
      userCount: 1000,
      stats: { lastNotifiedCount: 998, lastMilestone: 500 },
    });
    const reporter = new MemberGrowthReporter(
      prisma,
      { notifyMemberGrowth, notifyMemberMilestone } as never,
      fakeLogger(),
    );

    await reporter.reportOnce();

    expect(notifyMemberGrowth).toHaveBeenCalledWith({ newCount: 2, totalMembers: 1000 });
    expect(notifyMemberMilestone).toHaveBeenCalledTimes(1);
    expect(notifyMemberMilestone).toHaveBeenCalledWith({ milestone: 1000, totalMembers: 1000 });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'bot_member_stats' },
      data: { lastNotifiedCount: 1000, lastMilestone: 1000 },
    });
  });

  it('fires every milestone crossed in a single jump, not just the highest', async () => {
    const notifyMemberGrowth = vi.fn().mockResolvedValue(undefined);
    const notifyMemberMilestone = vi.fn().mockResolvedValue(undefined);
    const { prisma, update } = fakePrisma({
      userCount: 6000,
      stats: { lastNotifiedCount: 400, lastMilestone: 0 },
    });
    const reporter = new MemberGrowthReporter(
      prisma,
      { notifyMemberGrowth, notifyMemberMilestone } as never,
      fakeLogger(),
    );

    await reporter.reportOnce();

    expect(notifyMemberMilestone).toHaveBeenCalledTimes(4);
    expect(notifyMemberMilestone).toHaveBeenNthCalledWith(1, {
      milestone: 100,
      totalMembers: 6000,
    });
    expect(notifyMemberMilestone).toHaveBeenNthCalledWith(2, {
      milestone: 500,
      totalMembers: 6000,
    });
    expect(notifyMemberMilestone).toHaveBeenNthCalledWith(3, {
      milestone: 1000,
      totalMembers: 6000,
    });
    expect(notifyMemberMilestone).toHaveBeenNthCalledWith(4, {
      milestone: 5000,
      totalMembers: 6000,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'bot_member_stats' },
      data: { lastNotifiedCount: 6000, lastMilestone: 5000 },
    });
  });

  it('sends nothing and does not write when the count has not changed', async () => {
    const notifyMemberGrowth = vi.fn().mockResolvedValue(undefined);
    const notifyMemberMilestone = vi.fn().mockResolvedValue(undefined);
    const { prisma, update } = fakePrisma({
      userCount: 2541,
      stats: { lastNotifiedCount: 2541, lastMilestone: 1000 },
    });
    const reporter = new MemberGrowthReporter(
      prisma,
      { notifyMemberGrowth, notifyMemberMilestone } as never,
      fakeLogger(),
    );

    await reporter.reportOnce();

    expect(notifyMemberGrowth).not.toHaveBeenCalled();
    expect(notifyMemberMilestone).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('logs a warning instead of throwing when the Telegram send fails', async () => {
    const notifyMemberGrowth = vi.fn().mockRejectedValue(new Error('telegram down'));
    const logger = fakeLogger();
    const { prisma, update } = fakePrisma({
      userCount: 2546,
      stats: { lastNotifiedCount: 2541, lastMilestone: 1000 },
    });
    const reporter = new MemberGrowthReporter(prisma, { notifyMemberGrowth } as never, logger);

    await reporter.reportOnce();

    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledTimes(1);
    // Still persists the new count — the poll itself succeeded, only delivery failed.
    expect(update).toHaveBeenCalledWith({
      where: { id: 'bot_member_stats' },
      data: { lastNotifiedCount: 2546, lastMilestone: 1000 },
    });
  });

  it('start() is idempotent and stop() prevents further polls', async () => {
    const notifyMemberGrowth = vi.fn().mockResolvedValue(undefined);
    const { prisma } = fakePrisma({
      userCount: 2546,
      stats: { lastNotifiedCount: 2541, lastMilestone: 1000 },
    });
    const reporter = new MemberGrowthReporter(
      prisma,
      { notifyMemberGrowth } as never,
      fakeLogger(),
    );

    reporter.start(1000);
    reporter.start(1000);
    reporter.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(notifyMemberGrowth).not.toHaveBeenCalled();
  });
});
