import { describe, expect, it } from 'vitest';
import { CATEGORIES, pickNextCategory } from './categories.js';

describe('pickNextCategory', () => {
  it('never repeats the most recent category', () => {
    for (const last of CATEGORIES) {
      // Force the "roll" to the top of the weight range so the excluded
      // category would have been picked first if it weren't filtered out.
      const category = pickNextCategory([last], () => 0);
      expect(category).not.toBe(last);
    }
  });

  it('always returns a valid category', () => {
    for (let seed = 0; seed <= 10; seed++) {
      const category = pickNextCategory([], () => seed / 10);
      expect(CATEGORIES).toContain(category);
    }
  });

  it('falls back to the full pool when history is empty', () => {
    const category = pickNextCategory([], () => 0.999);
    expect(CATEGORIES).toContain(category);
  });
});
