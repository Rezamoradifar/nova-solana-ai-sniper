const MIN_POSTS_PER_DAY = 3;
const MAX_POSTS_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Keep posts spread out — never less than 45 minutes apart, even with unlucky random draws. */
const MIN_GAP_MS = 45 * 60 * 1000;

/**
 * Generates 3-5 random timestamps within [dayStart, dayStart + 24h), spaced
 * at least MIN_GAP_MS apart, sorted ascending. Pure and seedable so the
 * distribution can be unit tested without relying on wall-clock time.
 */
export function planDailyPostTimes(dayStart: Date, random: () => number = Math.random): Date[] {
  const count =
    MIN_POSTS_PER_DAY + Math.floor(random() * (MAX_POSTS_PER_DAY - MIN_POSTS_PER_DAY + 1));
  const offsets: number[] = [];

  let attempts = 0;
  while (offsets.length < count && attempts < count * 50) {
    attempts++;
    const candidate = Math.floor(random() * DAY_MS);
    if (offsets.every((o) => Math.abs(o - candidate) >= MIN_GAP_MS)) {
      offsets.push(candidate);
    }
  }

  return offsets.sort((a, b) => a - b).map((offset) => new Date(dayStart.getTime() + offset));
}

/** Filters a day's planned post times down to ones still in the future relative to `now`. */
export function remainingPostTimes(plannedTimes: Date[], now: Date): Date[] {
  return plannedTimes.filter((t) => t.getTime() > now.getTime());
}
