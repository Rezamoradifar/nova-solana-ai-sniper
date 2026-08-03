import type { EcosystemFeedType } from './data.js';
import {
  pickNextFeedType as pickNextFeedTypeGeneric,
  type FeedTypeBacklog,
} from '../activityFeed/scheduler.js';

/**
 * Ecosystem Feed (2026-07-31) — reuses activityFeed/scheduler.ts's pure,
 * prisma/telegram-agnostic pick logic (generalized there to be generic over
 * the feed-type union) rather than duplicating it; the selection algorithm
 * has no dependency on which concrete set of categories it's choosing among.
 */

export type EcosystemFeedTypeBacklog = FeedTypeBacklog<EcosystemFeedType>;

export function pickNextEcosystemFeedType(
  backlogs: EcosystemFeedTypeBacklog[],
  lastPostedType: EcosystemFeedType | undefined,
  rng: () => number = Math.random,
): EcosystemFeedType | undefined {
  return pickNextFeedTypeGeneric<EcosystemFeedType>(backlogs, lastPostedType, rng);
}
