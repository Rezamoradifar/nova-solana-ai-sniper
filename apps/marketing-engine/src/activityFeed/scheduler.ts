import type { ActivityFeedType } from './data.js';

/**
 * Real-Data Telegram Activity Feed (2026-07-27) — pure pacing/selection
 * logic, independent of Prisma/Telegram so it's unit-testable without either.
 *
 * Deliberately has no notion of a *minimum* posts-per-day: `pickNextFeedType`
 * only ever chooses among feed types that report real, unposted backlog
 * (`count > 0`), and returns `undefined` when every type is empty. The
 * caller (monitor.ts) treats `undefined` as "post nothing this tick" — the
 * one thing this scheduler is built to never do is manufacture a message to
 * hit a volume target on a quiet day.
 */

/** Generic over the feed-type string union (defaults to this module's own
 * ActivityFeedType) so ../ecosystemFeed/scheduler.ts can reuse this same
 * pure pick logic under its own EcosystemFeedType, rather than duplicating
 * it — the logic has no dependency on which concrete union is used. */
export interface FeedTypeBacklog<T extends string = ActivityFeedType> {
  type: T;
  count: number;
}

/** Random delay before the next check-worthy post, in ms — natural pacing
 * (a fixed cadence would read as an obvious bot timer) within
 * [minMinutes, maxMinutes]. */
export function randomIntervalMs(
  minMinutes: number,
  maxMinutes: number,
  rng: () => number = Math.random,
): number {
  const minMs = minMinutes * 60_000;
  const maxMs = maxMinutes * 60_000;
  if (maxMs <= minMs) return minMs;
  return minMs + rng() * (maxMs - minMs);
}

/**
 * Picks one feed type to post next, at random among those with real
 * backlog. Avoids repeating the immediately-previous type UNLESS that's the
 * only type with any backlog at all — a quiet stretch where only one real
 * signal exists shouldn't go silent forever just to avoid a repeat.
 */
export function pickNextFeedType<T extends string = ActivityFeedType>(
  backlogs: FeedTypeBacklog<T>[],
  lastPostedType: T | undefined,
  rng: () => number = Math.random,
): T | undefined {
  const withBacklog = backlogs.filter((b) => b.count > 0);
  if (withBacklog.length === 0) return undefined;

  const excludingLast = withBacklog.filter((b) => b.type !== lastPostedType);
  const pool = excludingLast.length > 0 ? excludingLast : withBacklog;

  const idx = Math.min(Math.floor(rng() * pool.length), pool.length - 1);
  const selected = pool[idx];
  // Unreachable: idx is clamped into [0, pool.length - 1] and pool.length > 0
  // was just established above — satisfies noUncheckedIndexedAccess.
  if (!selected) return undefined;
  return selected.type;
}

export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** True once `postsToday` (already reset for the current UTC day by the
 * caller) has reached the soft daily ceiling — see
 * ACTIVITY_FEED_MAX_POSTS_PER_DAY's own env.ts doc comment for why this is a
 * ceiling only, never paired with a minimum. */
export function isDailyCapReached(postsToday: number, maxPostsPerDay: number): boolean {
  return postsToday >= maxPostsPerDay;
}
