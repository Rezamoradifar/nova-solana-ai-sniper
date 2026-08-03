import { describe, expect, it } from 'vitest';
import { pickNextEcosystemFeedType } from './scheduler.js';
import { ECOSYSTEM_FEED_TYPES } from './data.js';

describe('pickNextEcosystemFeedType', () => {
  it('only picks among categories with real backlog', () => {
    const chosen = pickNextEcosystemFeedType(
      [
        { type: ECOSYSTEM_FEED_TYPES.TRENDING_TOKEN, count: 0 },
        { type: ECOSYSTEM_FEED_TYPES.HIDDEN_GEM, count: 3 },
      ],
      undefined,
      () => 0,
    );
    expect(chosen).toBe(ECOSYSTEM_FEED_TYPES.HIDDEN_GEM);
  });

  it('returns undefined when every category is empty, never manufacturing a post', () => {
    const chosen = pickNextEcosystemFeedType(
      [
        { type: ECOSYSTEM_FEED_TYPES.TRENDING_TOKEN, count: 0 },
        { type: ECOSYSTEM_FEED_TYPES.HIDDEN_GEM, count: 0 },
      ],
      undefined,
    );
    expect(chosen).toBeUndefined();
  });

  it('avoids repeating the immediately-previous type when another has backlog', () => {
    const chosen = pickNextEcosystemFeedType(
      [
        { type: ECOSYSTEM_FEED_TYPES.TRENDING_TOKEN, count: 2 },
        { type: ECOSYSTEM_FEED_TYPES.HIDDEN_GEM, count: 2 },
      ],
      ECOSYSTEM_FEED_TYPES.TRENDING_TOKEN,
      () => 0,
    );
    expect(chosen).toBe(ECOSYSTEM_FEED_TYPES.HIDDEN_GEM);
  });
});
