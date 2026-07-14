import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';

/**
 * Production blocking fix (2026-07-14): mutual exclusion for every
 * money-moving action on a single Position — closePosition (normal TP, stop
 * loss, trailing stop, emergency exit, and any future manual close all funnel
 * through it) and executePartialSell (institutional mode's profit ladder).
 *
 * Before this, the only guard was unverifiedSwapLocks, which is set AFTER a
 * swap already landed on-chain — nothing stopped two independent timers
 * (PriceMonitor.tick and EmergencyExitMonitor.tick both run in this same
 * process, see worker.ts) from both reading the same position as OPEN and
 * both submitting a sell in the same window. This adds two layers:
 *
 *  1. An in-process Set, checked/set synchronously (no `await` between check
 *     and set) so the common single-process case never needs a DB round trip
 *     to lose the race.
 *  2. A DB-backed claim (PositionCloseClaim, a separate table rather than
 *     columns on Position — see schema.prisma's doc comment on that model),
 *     acquired via a plain INSERT whose primary-key uniqueness IS the
 *     cross-process/cross-instance guarantee: two concurrent claim attempts
 *     for the same positionId can never both succeed. A claim older than
 *     STALE_LOCK_TTL_MS is treated as abandoned (the holder crashed
 *     mid-swap) and can be reclaimed — same auto-recovery philosophy as
 *     unverifiedSwapLocks itself, never a permanent lockout.
 */

const STALE_LOCK_TTL_MS = 5 * 60 * 1000;

function isUniqueConstraintError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

export interface PositionLockHandle {
  readonly positionId: string;
  readonly token: string;
  release(): Promise<void>;
}

export class PositionCloseLock {
  private readonly inProcess = new Set<string>();

  /**
   * Attempts to claim exclusive rights to close/partially-sell `positionId`.
   * Returns undefined if another operation already holds a live claim
   * (in-process or in the DB) — callers must treat that as "someone else is
   * already handling this position right now" and back off, never retry
   * blindly in the same tick.
   */
  async acquire(
    prisma: PrismaClient,
    positionId: string,
    logger: Logger,
  ): Promise<PositionLockHandle | undefined> {
    if (this.inProcess.has(positionId)) return undefined;
    this.inProcess.add(positionId);

    try {
      const token = randomUUID();
      const claimed = await this.tryClaim(prisma, positionId, token, logger);
      if (!claimed) {
        this.inProcess.delete(positionId);
        return undefined;
      }

      let released = false;
      return {
        positionId,
        token,
        release: async () => {
          if (released) return;
          released = true;
          this.inProcess.delete(positionId);
          // Only clears a claim this handle actually still owns — if the TTL
          // expired and a different attempt already reclaimed it, that
          // newer claim must never be deleted by this stale release.
          await prisma.positionCloseClaim
            .deleteMany({ where: { positionId, token } })
            .catch((err) => {
              logger.error({ err, positionId }, 'positionCloseLock: release failed');
            });
        },
      };
    } catch (err) {
      this.inProcess.delete(positionId);
      throw err;
    }
  }

  /** A plain INSERT — Postgres's own primary-key uniqueness on positionId is
   * the atomicity guarantee; no explicit transaction/row-lock needed for the
   * claim itself. Falls through to a one-shot stale-reclaim attempt (delete
   * the abandoned row, then re-insert) when the existing claim is old enough
   * to be considered abandoned. */
  private async tryClaim(
    prisma: PrismaClient,
    positionId: string,
    token: string,
    logger: Logger,
  ): Promise<boolean> {
    try {
      await prisma.positionCloseClaim.create({ data: { positionId, token } });
      return true;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }

    const existing = await prisma.positionCloseClaim.findUnique({ where: { positionId } });
    if (!existing) {
      // Raced with a release that landed between our failed create and this
      // read — the position is free again right now, try once more.
      return this.tryClaim(prisma, positionId, token, logger);
    }

    const staleForMs = Date.now() - existing.claimedAt.getTime();
    if (staleForMs < STALE_LOCK_TTL_MS) return false;

    logger.warn(
      { positionId, staleForMs },
      'positionCloseLock: stale claim auto-recovered (previous holder never released it)',
    );
    // Conditional on token so a claim that was itself just reclaimed by a
    // third attempt in between is never deleted out from under it.
    const deleted = await prisma.positionCloseClaim.deleteMany({
      where: { positionId, token: existing.token },
    });
    if (deleted.count === 0) return false;

    try {
      await prisma.positionCloseClaim.create({ data: { positionId, token } });
      return true;
    } catch (err) {
      if (isUniqueConstraintError(err)) return false;
      throw err;
    }
  }
}

/** One shared lock table for the whole process — PositionManager is itself
 * effectively a singleton per app.ts wiring, but this is exported
 * independently so any other future caller (a manual-close route, a backfill
 * script) claims against the exact same in-process Set, not a second one. */
export const positionCloseLock = new PositionCloseLock();
