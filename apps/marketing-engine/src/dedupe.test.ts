import { describe, expect, it } from 'vitest';
import { isNearDuplicate } from './dedupe.js';

describe('isNearDuplicate', () => {
  it('is false when there are no recent posts to compare against', () => {
    expect(isNearDuplicate('Set your stop-loss before you ape into a new launch.', [])).toBe(false);
  });

  it('is false for genuinely different content in the same category', () => {
    const recent = ['Set your stop-loss before you ape into a new launch.'];
    expect(
      isNearDuplicate(
        'Position sizing matters more than most traders think — never risk more than a small slice of your bankroll on one snipe.',
        recent,
      ),
    ).toBe(false);
  });

  it('is true for a near-identical rewording of a recent post', () => {
    const recent = [
      'Always set a stop-loss before you snipe a fresh token launch — protect your downside first.',
    ];
    expect(
      isNearDuplicate(
        'Always set a stop-loss before you snipe a fresh token launch, protecting your downside first.',
        recent,
      ),
    ).toBe(true);
  });

  it('is true for an exact repeat', () => {
    const recent = ['GSP Bank Sniper screens every launch before it ever reaches your wallet.'];
    expect(isNearDuplicate(recent[0]!, recent)).toBe(true);
  });

  it('handles Persian text (no Latin-only assumption)', () => {
    const recent = [
      'همیشه پیش از خرید یک توکن جدید، حد ضرر خود را تنظیم کنید تا سرمایه‌تان محافظت شود.',
    ];
    expect(
      isNearDuplicate(
        'همیشه پیش از خرید یک توکن جدید حد ضرر خود را تنظیم کنید تا سرمایه‌تان محافظت شود',
        recent,
      ),
    ).toBe(true);
  });

  it('is false when compared against unrelated Persian content', () => {
    const recent = ['همیشه پیش از خرید یک توکن جدید، حد ضرر خود را تنظیم کنید.'];
    expect(
      isNearDuplicate(
        'برنامه رفرال به شما اجازه می‌دهد با دعوت دوستان خود کسب درآمد کنید.',
        recent,
      ),
    ).toBe(false);
  });
});
