import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';

/** Ascending, matches the Telegram Member Counter spec exactly. */
export const MEMBER_MILESTONES = [100, 500, 1_000, 5_000, 10_000, 25_000, 50_000, 100_000] as const;

const STATS_ROW_ID = 'bot_member_stats';

/**
 * Telegram Member Counter (2026-07-27): polls the total registered-bot-user
 * count (User rows with telegramId set) on a fixed interval and turns any
 * increase since the last poll into one batched Telegram notification to the
 * owner — same periodic-snapshot convention as SecurityGateSummaryReporter,
 * chosen so N users joining inside one interval collapse into a single "+N"
 * message instead of N separate ones. Milestone crossings (MEMBER_MILESTONES)
 * are reported once each, tracked via the BotMemberStats singleton row so a
 * process restart never re-sends growth already reported or re-fires a
 * milestone already crossed.
 */
export class MemberGrowthReporter {
  private timer: ReturnType<typeof setInterval> | undefined;
  // Guards against overlapping runs (read-then-write across two DB calls,
  // unlike SecurityGateSummaryReporter's atomic in-memory snapshot) if a poll
  // ever takes longer than the interval.
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifier: NotificationService | undefined,
    private readonly logger: Logger,
  ) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reportOnce();
    }, intervalMs);
    // Never keeps the process alive on its own — same convention as every
    // other interval-based monitor in this codebase (see priceMonitor.ts).
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async reportOnce(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.doReport();
    } finally {
      this.isRunning = false;
    }
  }

  private async doReport(): Promise<void> {
    const currentCount = await this.prisma.user.count({
      where: { telegramId: { not: null } },
    });
    const stats = await this.prisma.botMemberStats.findUnique({ where: { id: STATS_ROW_ID } });

    if (!stats) {
      // First run ever: establish a baseline without notifying — otherwise
      // deploying this feature onto an existing user base would fire one
      // giant false "+N users" burst, and re-fire every milestone already
      // long since passed.
      const baselineMilestone =
        [...MEMBER_MILESTONES].reverse().find((m) => m <= currentCount) ?? 0;
      await this.prisma.botMemberStats.create({
        data: {
          id: STATS_ROW_ID,
          lastNotifiedCount: currentCount,
          lastMilestone: baselineMilestone,
        },
      });
      return;
    }

    const delta = currentCount - stats.lastNotifiedCount;
    const newMilestones = MEMBER_MILESTONES.filter(
      (m) => m > stats.lastMilestone && m <= currentCount,
    );

    if (delta <= 0 && newMilestones.length === 0) return;

    if (delta > 0) {
      try {
        await this.notifier?.notifyMemberGrowth({ newCount: delta, totalMembers: currentCount });
      } catch (err) {
        this.logger.warn({ err }, 'member growth reporter: failed to send growth notification');
      }
    }

    for (const milestone of newMilestones) {
      try {
        await this.notifier?.notifyMemberMilestone({ milestone, totalMembers: currentCount });
      } catch (err) {
        this.logger.warn(
          { err, milestone },
          'member growth reporter: failed to send milestone notification',
        );
      }
    }

    await this.prisma.botMemberStats.update({
      where: { id: STATS_ROW_ID },
      data: {
        lastNotifiedCount: currentCount,
        lastMilestone: newMilestones.length > 0 ? Math.max(...newMilestones) : stats.lastMilestone,
      },
    });
  }
}
